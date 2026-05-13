import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import { notifyError } from "../../../../src/trigger/lib/alerting.js";

const RC_SERVER = "https://platform.ringcentral.com";

/**
 * Poll RingCentral call log as a safety net for missed webhooks. Default
 * lookback is 10 minutes (every-5-minute cadence with overlap). The
 * event-triggered backfill variant accepts `lookback_minutes` (e.g.
 * 1440 for the last 24h) to catch up after an outage.
 *
 * For new completed calls (≥30s), inserts a `call_logs` row + fires
 * `call/transcribe.requested` so the Deepgram pipeline picks it up.
 *
 * Ported from `src/trigger/poll-rc-calls.ts` — Inngest is the only
 * scheduler now. The transcription dispatch was previously a
 * Trigger.dev `processCallDeepgram.trigger(...)` call; it now sends
 * the canonical Inngest event so we don't need both engines to be
 * registered.
 */

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
    const { data: c } = await supabase.from("people").select("id, full_name").eq("phone", v).maybeSingle();
    if (c) return { id: c.id, name: c.full_name, type: "candidate" };
  }
  for (const v of variants) {
    const { data: c } = await supabase.from("contacts").select("id, full_name").eq("phone", v).maybeSingle();
    if (c) return { id: c.id, name: c.full_name, type: "contact" };
  }
  return null;
}

async function getToken(supabase: any, acct: any, logger: any): Promise<string | null> {
  if (acct.access_token && acct.token_expires_at) {
    if (new Date(acct.token_expires_at) > new Date(Date.now() + 60_000)) return acct.access_token;
  }
  const meta = acct.metadata ?? {};
  const clientId = meta.rc_client_id;
  const clientSecret = meta.rc_client_secret;
  const jwt = acct.rc_jwt;
  if (!clientId || !clientSecret || !jwt) {
    await notifyError({
      taskId: "poll-rc-calls",
      severity: "ERROR",
      error: new Error(`RC account ${acct.account_label} is missing rc_client_id/secret or rc_jwt — re-auth required`),
      context: { accountId: acct.id, accountLabel: acct.account_label },
    });
    return null;
  }

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
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    logger.error("RC token refresh failed", { account: acct.account_label, status: res.status, body });
    // Don't fall back to the stale token — that just guarantees the next
    // call-log fetch 401s and the loop silently breaks. Skip the account
    // and alert so the user knows re-auth is needed.
    await notifyError({
      taskId: "poll-rc-calls",
      severity: "ERROR",
      error: new Error(`RC token refresh ${res.status} for ${acct.account_label} — re-auth required: ${body}`),
      context: { accountId: acct.id, accountLabel: acct.account_label, status: res.status },
    });
    return null;
  }
  const tok = await res.json();
  // Persist the refreshed token so subsequent polls reuse it instead of
  // hammering RC's token endpoint every cron tick (and so the
  // `updated_at` timestamp accurately reflects activity).
  await supabase
    .from("integration_accounts")
    .update({
      access_token: tok.access_token,
      token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", acct.id);
  return tok.access_token as string;
}

async function runPoll(lookbackMinutes: number, logger: any) {
  const supabase = getSupabaseAdmin();

  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, owner_user_id, account_label, rc_jwt, access_token, token_expires_at, metadata")
    .eq("provider", "sms")
    .eq("is_active", true)
    .not("rc_jwt", "is", null);

  if (!accounts?.length) {
    logger.info("No RC accounts found");
    return { calls_scanned: 0, calls_inserted: 0, calls_skipped: 0, lookback_minutes: lookbackMinutes, results: [] };
  }

  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  let totalProcessed = 0,
    totalInserted = 0,
    totalSkipped = 0;
  const results: any[] = [];
  const transcribeEvents: Array<{ name: "call/transcribe.requested"; data: { call_log_id: string } }> = [];

  for (const acct of accounts) {
    const token = await getToken(supabase, acct, logger);
    if (!token) {
      logger.warn(`No token for ${acct.account_label}`);
      continue;
    }

    let page = 1;
    while (page <= 30) {
      const params = new URLSearchParams({
        type: "Voice",
        view: "Detailed",
        dateFrom: since,
        perPage: "100",
        page: String(page),
      });

      const logRes = await fetch(
        `${RC_SERVER}/restapi/v1.0/account/~/extension/~/call-log?${params}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );

      if (!logRes.ok) {
        const body = (await logRes.text()).slice(0, 300);
        logger.error(`Call-log error ${logRes.status} for ${acct.account_label}`, { body });
        // 401/403 means our token is rejected — almost always re-auth.
        // Surface it so the user actually sees the breakage instead of
        // calls quietly disappearing for days.
        if (logRes.status === 401 || logRes.status === 403) {
          await notifyError({
            taskId: "poll-rc-calls",
            severity: "ERROR",
            error: new Error(`RC call-log ${logRes.status} for ${acct.account_label} — re-auth required: ${body}`),
            context: { accountId: acct.id, accountLabel: acct.account_label, status: logRes.status },
          });
        }
        break;
      }

      const logData = await logRes.json();
      const records = logData.records ?? [];
      logger.info(`${acct.account_label} page ${page}: ${records.length} calls since ${since}`);

      for (const call of records) {
        totalProcessed++;
        const callId = call.id ?? call.sessionId;
        if (!callId) {
          totalSkipped++;
          continue;
        }

        const { data: existing } = await supabase
          .from("call_logs")
          .select("id")
          .eq("external_call_id", callId)
          .maybeSingle();
        if (existing) {
          totalSkipped++;
          continue;
        }

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

          if (duration >= 30 && status === "completed") {
            const { data: inserted } = await supabase
              .from("call_logs")
              .select("id")
              .eq("external_call_id", callId)
              .maybeSingle();
            if (inserted?.id) {
              transcribeEvents.push({
                name: "call/transcribe.requested",
                data: { call_log_id: inserted.id },
              });
            }
          }
        }
      }

      if (records.length < 100) break;
      page++;
    }
  }

  // Inngest's send accepts up to 5000 events per call. Chunk just to be safe.
  if (transcribeEvents.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < transcribeEvents.length; i += chunkSize) {
      await inngest.send(transcribeEvents.slice(i, i + chunkSize));
    }
    logger.info("Dispatched transcription events", { count: transcribeEvents.length });
  }

  logger.info("Poll RC calls complete", { totalProcessed, totalInserted, totalSkipped, lookbackMinutes });
  return {
    calls_scanned: totalProcessed,
    calls_inserted: totalInserted,
    calls_skipped: totalSkipped,
    transcribe_dispatched: transcribeEvents.length,
    lookback_minutes: lookbackMinutes,
    results,
  };
}

export const pollRcCalls = inngest.createFunction(
  { id: "poll-rc-calls", name: "Poll RingCentral call log (Inngest)" },
  { cron: "*/5 * * * *" },
  async ({ logger }) => runPoll(10, logger),
);

/**
 * Event-triggered backfill version. Send via:
 *   await inngest.send({
 *     name: "ops/backfill-rc-calls.requested",
 *     data: { lookback_minutes: 1440 },
 *   });
 */
export const backfillRcCalls = inngest.createFunction(
  { id: "backfill-rc-calls", name: "Backfill RingCentral call log (Inngest)" },
  { event: "ops/backfill-rc-calls.requested" },
  async ({ event, logger }) => {
    const minutes = (event.data as any)?.lookback_minutes ?? 60;
    return runPoll(minutes, logger);
  },
);
