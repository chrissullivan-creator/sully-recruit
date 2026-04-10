import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

// Poll RingCentral call log as a safety net for missed webhooks.
// Looks back 10 minutes, dedupes against call_logs table.
//
// Schedule: every 5 minutes

const RC_SERVER = "https://platform.ringcentral.com";

async function getToken(acct: any): Promise<string | null> {
  if (acct.access_token && acct.token_expires_at) {
    if (new Date(acct.token_expires_at) > new Date(Date.now() + 60_000)) return acct.access_token;
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
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) return acct.access_token ?? null;
  return (await res.json()).access_token;
}

async function findEntityByPhone(
  supabase: any,
  phone: string,
): Promise<{ id: string; name: string; type: string } | null> {
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

export const pollRcCalls = schedules.task({
  id: "poll-rc-calls",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, account_label, rc_jwt, access_token, token_expires_at, metadata")
      .eq("provider", "sms")
      .eq("is_active", true)
      .not("rc_jwt", "is", null);

    if (!accounts?.length) {
      logger.info("No RC accounts found");
      return { calls_scanned: 0, calls_inserted: 0 };
    }

    // Look back 10 minutes
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    let totalProcessed = 0, totalInserted = 0, totalSkipped = 0;
    const results: any[] = [];

    for (const acct of accounts) {
      const token = await getToken(acct);
      if (!token) {
        logger.warn(`No token for ${acct.account_label}`);
        continue;
      }

      const params = new URLSearchParams({
        type: "Voice",
        view: "Detailed",
        dateFrom: since,
        perPage: "50",
      });

      const logRes = await fetch(
        `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log?${params}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
      );

      if (!logRes.ok) {
        logger.warn(`Call-log error ${logRes.status} for ${acct.account_label}`);
        continue;
      }

      const logData = await logRes.json();
      const records = logData.records ?? [];
      logger.info(`${acct.account_label}: ${records.length} calls since ${since}`);

      for (const call of records) {
        totalProcessed++;
        const callId = call.id ?? call.sessionId;
        if (!callId) { totalSkipped++; continue; }

        // Dedup
        const { data: existing } = await supabase
          .from("call_logs")
          .select("id")
          .eq("external_call_id", callId)
          .maybeSingle();
        if (existing) { totalSkipped++; continue; }

        const duration = call.duration ?? 0;
        const direction = (call.direction ?? "Outbound").toLowerCase();
        const otherParty = direction === "outbound" ? call.to : call.from;
        const otherPhone = otherParty?.phoneNumber ?? otherParty?.extensionNumber ?? null;
        const entity = otherPhone ? await findEntityByPhone(supabase, otherPhone) : null;

        let status = "completed";
        if (call.result === "Missed") status = "missed";
        else if (call.result === "Voicemail") status = "voicemail";
        else if (duration === 0) status = "missed";

        const startedAt = call.startTime ? new Date(call.startTime).toISOString() : null;
        const endedAt =
          startedAt && duration > 0
            ? new Date(new Date(call.startTime).getTime() + duration * 1000).toISOString()
            : null;

        const { error: insertErr } = await supabase.from("call_logs").insert({
          owner_id: acct.owner_user_id,
          phone_number: otherPhone,
          direction,
          duration_seconds: duration,
          started_at: startedAt,
          ended_at: endedAt,
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
          logger.error(`Insert error for call ${callId}`, { error: insertErr.message });
          totalSkipped++;
        } else {
          totalInserted++;
          results.push({
            call_id: callId,
            direction,
            duration,
            status,
            phone: otherPhone,
            entity: entity?.name ?? "unlinked",
            account: acct.account_label,
          });
        }
      }
    }

    logger.info("Poll RC calls complete", { totalProcessed, totalInserted, totalSkipped });
    return { calls_scanned: totalProcessed, calls_inserted: totalInserted, calls_skipped: totalSkipped, results };
  },
});
