import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RC_SERVER = "https://platform.ringcentral.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function getToken(acct: any, supabase: any): Promise<string | null> {
  if (acct.access_token && acct.token_expires_at) {
    if (new Date(acct.token_expires_at) > new Date(Date.now() + 60000)) return acct.access_token;
  }
  const meta = acct.metadata ?? {};
  if (!meta.rc_client_id || !meta.rc_client_secret || !acct.rc_jwt) return acct.access_token ?? null;
  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${meta.rc_client_id}:${meta.rc_client_secret}`)}` },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: acct.rc_jwt }),
  });
  if (!res.ok) return acct.access_token ?? null;
  const data = await res.json();
  await supabase.from("integration_accounts").update({
    access_token: data.access_token,
    token_expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  }).eq("id", acct.id);
  return data.access_token;
}

async function findEntityByPhone(supabase: any, phone: string) {
  const digits = phone.replace(/\D/g, "");
  const variants = [
    phone,
    `+${digits}`,
    digits,
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null,
    digits.length === 10 ? `+1${digits}` : null,
  ].filter(Boolean) as string[];

  for (const v of variants) {
    const { data: c } = await supabase.from("candidates").select("id, full_name").eq("phone", v).maybeSingle();
    if (c) return { id: c.id, name: c.full_name, type: "candidate" };
  }
  for (const v of variants) {
    const { data: c } = await supabase.from("contacts").select("id, full_name").eq("phone", v).maybeSingle();
    if (c) return { id: c.id, name: c.full_name, type: "contact" };
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const months_back = body.months_back ?? 12;
    const max_pages = body.max_pages ?? 50; // 100 calls/page = up to 5000 per run
    const min_duration = body.min_duration ?? 0; // No minimum — capture everything

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, account_label, rc_jwt, access_token, token_expires_at, metadata")
      .eq("provider", "sms").eq("is_active", true).not("rc_jwt", "is", null);

    if (!accounts?.length) return respond({ error: "No RC accounts found — check integration_accounts table" }, 404);

    const dateFrom = new Date(Date.now() - months_back * 30 * 24 * 60 * 60 * 1000)
      .toISOString().replace(/\.\d{3}Z$/, "Z");

    console.log(`[backfill-calls] Starting backfill from ${dateFrom}, accounts: ${accounts.length}`);

    let total_scanned = 0, total_inserted = 0, total_skipped = 0;
    const results: any[] = [];

    for (const acct of accounts) {
      const token = await getToken(acct, supabase);
      if (!token) {
        console.warn(`[backfill-calls] no token for ${acct.account_label}`);
        continue;
      }

      let page = 0;
      let pageToken: string | null = null;
      let acct_inserted = 0;

      while (page < max_pages) {
        page++;

        // NO withRecording filter — get ALL calls
        // NO direction filter — get both inbound and outbound
        const params = new URLSearchParams({
          type: "Voice",
          view: "Detailed",
          perPage: "100",
          dateFrom,
        });
        if (pageToken) params.set("pageToken", pageToken);

        const logRes = await fetch(
          `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log?${params}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
        );

        if (!logRes.ok) {
          const errText = await logRes.text();
          console.warn(`[backfill-calls] call-log error ${logRes.status} for ${acct.account_label}: ${errText.slice(0, 200)}`);
          break;
        }

        const logData = await logRes.json();
        const records = logData.records ?? [];
        pageToken = logData.navigation?.nextPage?.pageToken ?? null;

        console.log(`[backfill-calls] ${acct.account_label} page ${page}: ${records.length} records`);

        for (const call of records) {
          total_scanned++;
          const duration = call.duration ?? 0;
          const callId = call.id ?? call.sessionId;

          if (!callId) { total_skipped++; continue; }
          if (duration < min_duration) { total_skipped++; continue; }

          // Dedup check against call_logs
          const { data: existing } = await supabase
            .from("call_logs")
            .select("id")
            .eq("external_call_id", callId)
            .maybeSingle();
          if (existing) { total_skipped++; continue; }

          // Find the other party
          const otherParty = call.direction === "Outbound" ? call.to : call.from;
          const otherPhone = otherParty?.phoneNumber ?? otherParty?.extensionNumber ?? null;
          const entity = otherPhone ? await findEntityByPhone(supabase, otherPhone) : null;

          // Determine status
          let status = "completed";
          if (call.result === "Missed") status = "missed";
          else if (call.result === "Voicemail") status = "voicemail";
          else if (duration === 0) status = "missed";

          const started_at = call.startTime ? new Date(call.startTime).toISOString() : null;
          const ended_at = started_at && duration > 0
            ? new Date(new Date(call.startTime).getTime() + duration * 1000).toISOString()
            : null;

          const { error: insertErr } = await supabase.from("call_logs").insert({
            owner_id: acct.owner_user_id,
            phone_number: otherPhone,
            direction: (call.direction ?? "outbound").toLowerCase(),
            duration_seconds: duration,
            started_at,
            ended_at,
            status,
            external_call_id: callId,
            linked_entity_type: entity?.type ?? null,
            linked_entity_id: entity?.id ?? null,
            linked_entity_name: entity?.name ?? null,
            notes: call.result ?? null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          if (insertErr) {
            console.error(`[backfill-calls] insert error for ${callId}:`, insertErr.message);
            total_skipped++;
          } else {
            total_inserted++;
            acct_inserted++;
          }
        }

        if (!pageToken || records.length === 0) break;
      }

      console.log(`[backfill-calls] ${acct.account_label} done: inserted ${acct_inserted} calls`);
      results.push({ account: acct.account_label, inserted: acct_inserted });
    }

    return respond({
      success: true,
      total_scanned,
      total_inserted,
      total_skipped,
      results,
    });

  } catch (err: any) {
    console.error("[backfill-calls] fatal:", err?.message, err?.stack);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
