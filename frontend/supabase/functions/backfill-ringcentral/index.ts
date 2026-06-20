import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RC_CLIENT_ID = Deno.env.get("RC_CLIENT_ID") ?? "";
const RC_CLIENT_SECRET = Deno.env.get("RC_CLIENT_SECRET") ?? "";
const RC_SERVER = Deno.env.get("RC_SERVER") ?? "https://platform.ringcentral.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// ── Get RC access token ──────────────────────────────────────────
async function getRCToken(jwtToken: string): Promise<{ access_token: string; owner_id: string } | null> {
  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwtToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { access_token: data.access_token, owner_id: data.owner_id ?? "" };
}

// ── Fetch ALL call log pages from RC ──────────────────────────────
async function fetchAllCallLogs(accessToken: string, dateFrom: string): Promise<any[]> {
  const allRecords: any[] = [];
  let page = 1;
  const perPage = 250;

  while (true) {
    const url = new URL(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log`);
    url.searchParams.set("perPage", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("dateFrom", dateFrom);
    url.searchParams.set("recordingType", "All"); // Only calls WITH recordings
    url.searchParams.set("withRecording", "true");
    url.searchParams.set("type", "Voice");

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.log(`[backfill-rc] call-log page ${page} failed: ${res.status}`);
      break;
    }

    const data = await res.json();
    const records = data.records ?? [];
    allRecords.push(...records);

    console.log(`[backfill-rc] page ${page}: ${records.length} records (total so far: ${allRecords.length})`);

    const nav = data.navigation ?? {};
    const totalPages = data.paging?.totalPages ?? 1;
    if (page >= totalPages || records.length === 0) break;
    page++;
    await sleep(300); // be polite
  }

  return allRecords;
}

// ── Fetch SMS history (for completeness) ────────────────────────────
async function fetchAllSMS(accessToken: string, dateFrom: string): Promise<any[]> {
  const allRecords: any[] = [];
  let page = 1;

  while (true) {
    const url = new URL(`${RC_SERVER}/restapi/v1.0/account/~/extension/~/message-store`);
    url.searchParams.set("type", "SMS");
    url.searchParams.set("perPage", "250");
    url.searchParams.set("page", String(page));
    url.searchParams.set("dateFrom", dateFrom);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) break;

    const data = await res.json();
    const records = data.records ?? [];
    allRecords.push(...records);

    const totalPages = data.paging?.totalPages ?? 1;
    if (page >= totalPages || records.length === 0) break;
    page++;
    await sleep(200);
  }

  return allRecords;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const dry_run = body.dry_run ?? false;
    const process_recordings = body.process_recordings ?? true;
    const import_sms = body.import_sms ?? true;
    const import_calls = body.import_calls ?? true;
    // Go back 90 days by default (RC's standard retention)
    const days_back = body.days_back ?? 90;
    const dateFrom = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (!RC_CLIENT_ID || !RC_CLIENT_SECRET) {
      return respond({ error: "RC_CLIENT_ID and RC_CLIENT_SECRET not set in secrets" }, 400);
    }

    // Get all RC accounts with JWT
    const { data: rcAccounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, account_label, rc_jwt, rc_phone_number, rc_extension")
      .not("rc_jwt", "is", null)
      .eq("is_active", true);

    if (!rcAccounts?.length) {
      return respond({ error: "No RC accounts found with rc_jwt" }, 400);
    }

    // Build phone lookup: last 10 digits → {candidate_id?, contact_id?, name}
    const { data: candidates } = await supabase.from("candidates").select("id, full_name, phone").not("phone", "is", null);
    const { data: contacts } = await supabase.from("contacts").select("id, full_name, phone").not("phone", "is", null);

    const phoneLookup: Record<string, { candidate_id?: string; contact_id?: string; name: string }> = {};
    for (const c of candidates ?? []) {
      const n = normPhone(c.phone);
      if (n) phoneLookup[n] = { candidate_id: c.id, name: c.full_name ?? "" };
    }
    for (const c of contacts ?? []) {
      const n = normPhone(c.phone);
      if (n) phoneLookup[n] = { ...phoneLookup[n], contact_id: c.id, name: c.full_name ?? "" };
    }

    console.log(`[backfill-rc] phone lookup: ${Object.keys(phoneLookup).length} numbers | dateFrom: ${dateFrom}`);

    const results: Record<string, any> = {};

    for (const account of rcAccounts) {
      const label = account.account_label ?? "unknown";
      console.log(`[backfill-rc] processing account: ${label}`);

      const tokenData = await getRCToken(account.rc_jwt);
      if (!tokenData) {
        results[label] = { error: "Token exchange failed" };
        continue;
      }

      const { access_token } = tokenData;
      const accountResult: Record<string, any> = { sms: 0, calls_logged: 0, recordings_queued: 0, skipped: 0, errors: [] };

      // ── SMS backfill ──
      if (import_sms) {
        const smsRecords = await fetchAllSMS(access_token, dateFrom);
        console.log(`[backfill-rc] ${label}: ${smsRecords.length} SMS records`);

        for (const sms of smsRecords) {
          const providerMsgId = `rc_sms_${sms.id}`;
          const { data: existing } = await supabase.from("messages").select("id").eq("provider_message_id", providerMsgId).maybeSingle();
          if (existing) { accountResult.skipped++; continue; }

          const direction = sms.direction === "Outbound" ? "outbound" : "inbound";
          const fromNum = sms.from?.phoneNumber ?? "";
          const toNum = sms.to?.[0]?.phoneNumber ?? "";
          const matchPhone = normPhone(direction === "inbound" ? fromNum : toNum);
          const entity = phoneLookup[matchPhone];
          if (!entity?.candidate_id && !entity?.contact_id) { accountResult.skipped++; continue; }

          if (dry_run) { accountResult.sms++; continue; }

          const candidateId = entity.candidate_id ?? null;
          const contactId = entity.contact_id ?? null;

          // Get or create conversation
          let convId: string | null = null;
          if (candidateId) {
            const { data: conv } = await supabase.from("conversations").select("id").eq("candidate_id", candidateId).eq("channel", "sms").order("created_at", { ascending: false }).limit(1).maybeSingle();
            convId = conv?.id ?? null;
          } else if (contactId) {
            const { data: conv } = await supabase.from("conversations").select("id").eq("contact_id", contactId).eq("channel", "sms").order("created_at", { ascending: false }).limit(1).maybeSingle();
            convId = conv?.id ?? null;
          }

          if (!convId) {
            const { data: newConv } = await supabase.from("conversations").insert({
              channel: "sms", candidate_id: candidateId, contact_id: contactId,
              owner_id: account.owner_user_id, is_read: true,
              last_message_at: sms.creationTime, last_message_preview: (sms.subject ?? "").slice(0, 100),
            }).select("id").single();
            convId = newConv?.id ?? null;
          }

          if (!convId) continue;

          await supabase.from("messages").insert({
            conversation_id: convId, candidate_id: candidateId, contact_id: contactId,
            channel: "sms", direction, body: sms.subject ?? sms.body ?? "",
            sender_address: fromNum, recipient_address: toNum,
            sent_at: sms.creationTime, provider: "ringcentral",
            provider_message_id: providerMsgId,
            created_at: sms.creationTime, updated_at: new Date().toISOString(), inserted_at: new Date().toISOString(),
            is_read: true,
          });

          accountResult.sms++;
        }
      }

      // ── Call log + recordings backfill ──
      if (import_calls) {
        const callRecords = await fetchAllCallLogs(access_token, dateFrom);
        console.log(`[backfill-rc] ${label}: ${callRecords.length} call records with recordings`);

        for (const call of callRecords) {
          const externalCallId = String(call.id ?? call.sessionId ?? "");
          const recording = call.recording as Record<string, any> | undefined;
          const direction = call.direction === "Outbound" ? "outbound" : "inbound";
          const fromNum = call.from?.phoneNumber ?? "";
          const toNum = call.to?.phoneNumber ?? "";
          const duration = Number(call.duration ?? 0);
          const matchPhone = normPhone(direction === "outbound" ? toNum : fromNum);
          const entity = phoneLookup[matchPhone];
          const candidateId = entity?.candidate_id ?? null;
          const contactId = entity?.contact_id ?? null;

          // Upsert into call_logs
          const { data: existingLog } = await supabase.from("call_logs").select("id").eq("external_call_id", externalCallId).maybeSingle();
          if (!existingLog && !dry_run) {
            await supabase.from("call_logs").insert({
              phone_number: direction === "outbound" ? toNum : fromNum,
              direction, duration_seconds: duration,
              started_at: call.startTime ?? new Date().toISOString(),
              ended_at: call.startTime ? new Date(new Date(call.startTime).getTime() + duration * 1000).toISOString() : null,
              status: "completed",
              notes: `${call.result ?? ""} — ${duration}s`,
              external_call_id: externalCallId,
              owner_id: account.owner_user_id,
              linked_entity_type: candidateId ? "candidate" : (contactId ? "contact" : null),
              linked_entity_id: candidateId ?? contactId ?? null,
              linked_entity_name: entity?.name ?? null,
            }).throwOnError().catch(() => {});
            accountResult.calls_logged++;
          }

          // Also log as message
          const providerMsgId = `rc_call_${externalCallId}`;
          const { data: existingMsg } = await supabase.from("messages").select("id").eq("provider_message_id", providerMsgId).maybeSingle();
          if (!existingMsg && (candidateId || contactId) && !dry_run) {
            let convId: string | null = null;
            if (candidateId) {
              const { data: conv } = await supabase.from("conversations").select("id").eq("candidate_id", candidateId).eq("channel", "call").order("created_at", { ascending: false }).limit(1).maybeSingle();
              convId = conv?.id ?? null;
            } else if (contactId) {
              const { data: conv } = await supabase.from("conversations").select("id").eq("contact_id", contactId).eq("channel", "call").order("created_at", { ascending: false }).limit(1).maybeSingle();
              convId = conv?.id ?? null;
            }
            if (!convId) {
              const { data: newConv } = await supabase.from("conversations").insert({
                channel: "call", candidate_id: candidateId, contact_id: contactId,
                owner_id: account.owner_user_id, is_read: true,
                last_message_at: call.startTime, last_message_preview: `Call — ${duration}s — ${call.result ?? ""}`,
              }).select("id").single();
              convId = newConv?.id ?? null;
            }
            if (convId) {
              await supabase.from("messages").insert({
                conversation_id: convId, candidate_id: candidateId, contact_id: contactId,
                channel: "call", direction,
                body: `📞 Call — ${duration}s — ${call.result ?? ""}`,
                sender_address: fromNum, recipient_address: toNum,
                sent_at: call.startTime, provider: "ringcentral",
                provider_message_id: providerMsgId,
                created_at: call.startTime ?? new Date().toISOString(),
                updated_at: new Date().toISOString(), inserted_at: new Date().toISOString(),
                is_read: true,
              }).throwOnError().catch(() => {});
            }
          }

          // ── Process recording if present and call is long enough ──
          if (!process_recordings || !recording || duration < 30) continue;

          const recordingId = String(recording.id ?? "");
          const recordingContentUri = String(recording.contentUri ?? recording.uri ?? "");
          if (!recordingId && !recordingContentUri) continue;

          // Check if already processed
          const { data: existingNote } = await supabase
            .from("ai_call_notes")
            .select("id")
            .eq("external_call_id", externalCallId)
            .maybeSingle();
          if (existingNote) { accountResult.skipped++; continue; }

          if (dry_run) {
            accountResult.recordings_queued++;
            console.log(`[backfill-rc] DRY RUN: would process recording ${recordingId} for ${entity?.name ?? "unknown"} (${duration}s)`);
            continue;
          }

          // Fire process-call-recording async (don’t block the loop)
          const processUrl = `${SUPABASE_URL}/functions/v1/process-call-recording`;
          fetch(processUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({
              recording_url: recordingContentUri || null,
              recording_id: recordingId || null,
              call_id: externalCallId,
              candidate_id: candidateId,
              contact_id: contactId,
              owner_id: account.owner_user_id,
              call_direction: direction,
              call_duration_seconds: duration,
              call_started_at: call.startTime ?? null,
              call_ended_at: call.startTime ? new Date(new Date(call.startTime).getTime() + duration * 1000).toISOString() : null,
              phone_number: direction === "outbound" ? toNum : fromNum,
              rc_access_token: access_token,
            }),
          }).then(r => console.log(`[backfill-rc] recording ${recordingId} queued: ${r.status}`))
            .catch(e => console.warn(`[backfill-rc] recording trigger failed:`, e?.message));

          accountResult.recordings_queued++;
          // Small delay to avoid hammering Deepgram/Claude simultaneously
          await sleep(2000);
        }
      }

      results[label] = accountResult;
      console.log(`[backfill-rc] ${label} done:`, accountResult);
    }

    return respond({
      success: true,
      dry_run,
      date_from: dateFrom,
      days_back,
      accounts: results,
    });

  } catch (err: any) {
    console.error("[backfill-rc] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
