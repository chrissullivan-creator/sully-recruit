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

async function getToken(acct: any): Promise<string | null> {
  if (acct.access_token && acct.token_expires_at) {
    if (new Date(acct.token_expires_at) > new Date(Date.now() + 60000)) return acct.access_token;
  }
  const meta = acct.metadata ?? {};
  const clientId = meta.rc_client_id;
  const clientSecret = meta.rc_client_secret;
  const jwt = acct.rc_jwt;
  if (!clientId || !clientSecret || !jwt) return acct.access_token ?? null;
  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) return acct.access_token ?? null;
  return (await res.json()).access_token;
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
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, account_label, rc_jwt, access_token, token_expires_at, metadata")
      .eq("provider", "sms")
      .eq("is_active", true)
      .not("rc_jwt", "is", null);

    if (!accounts?.length) return respond({ error: "No RC accounts found" }, 404);

    // Look back 10 minutes — generous window to never miss a call
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

    let total_processed = 0, total_inserted = 0, total_skipped = 0;
    const results: any[] = [];

    for (const acct of accounts) {
      const token = await getToken(acct);
      if (!token) { console.warn(`[poll-calls] no token for ${acct.account_label}`); continue; }

      // NO withRecording filter, BOTH directions, NO duration minimum
      const params = new URLSearchParams({
        type: "Voice",
        view: "Detailed",
        dateFrom: since,
        perPage: "50",
      });

      const logRes = await fetch(
        `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log?${params}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
      );

      if (!logRes.ok) {
        console.warn(`[poll-calls] call-log error ${logRes.status} for ${acct.account_label}`);
        continue;
      }

      const logData = await logRes.json();
      const records = logData.records ?? [];
      console.log(`[poll-calls] ${acct.account_label}: ${records.length} calls since ${since}`);

      for (const call of records) {
        total_processed++;
        const callId = call.id ?? call.sessionId;
        if (!callId) { total_skipped++; continue; }

        // Dedup against call_logs
        const { data: existing } = await supabase
          .from("call_logs").select("id").eq("external_call_id", callId).maybeSingle();
        if (existing) { total_skipped++; continue; }

        const duration = call.duration ?? 0;
        const direction = (call.direction ?? "Outbound").toLowerCase();
        const otherParty = direction === "outbound" ? call.to : call.from;
        const otherPhone = otherParty?.phoneNumber ?? otherParty?.extensionNumber ?? null;
        const entity = otherPhone ? await findEntityByPhone(supabase, otherPhone) : null;

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
          direction,
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
          console.error(`[poll-calls] insert error ${callId}:`, insertErr.message);
          total_skipped++;
        } else {
          total_inserted++;
          results.push({
            call_id: callId,
            direction,
            duration,
            status,
            phone: otherPhone,
            entity: entity?.name ?? "unlinked",
            account: acct.account_label,
          });
          console.log(`[poll-calls] logged: ${entity?.name ?? otherPhone ?? "unknown"} ${direction} ${duration}s`);
        }
      }
    }

    return respond({ success: true, calls_scanned: total_processed, calls_inserted: total_inserted, calls_skipped: total_skipped, results });

  } catch (err: any) {
    console.error("[poll-calls] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
