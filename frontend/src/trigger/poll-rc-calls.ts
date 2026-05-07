import { schedules, task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { processCallDeepgram } from "./process-call-deepgram";

// Poll RingCentral call log as a safety net for missed webhooks.
// Default lookback is 10 minutes; the manual backfill task accepts a
// `lookback_minutes` payload (e.g. 1440 for the last 24h).
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
  if (!clientId || !clientSecret || !jwt) {
    logger.warn("RC credentials incomplete — cannot mint token", {
      account: acct.account_label,
      missing: {
        rc_client_id: !clientId,
        rc_client_secret: !clientSecret,
        rc_jwt: !jwt,
      },
    });
    return acct.access_token ?? null;
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
    logger.warn("RC JWT token exchange failed", {
      account: acct.account_label,
      status: res.status,
    });
    return acct.access_token ?? null;
  }
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
    const { data: c } = await supabase.from("people").select("id, full_name").eq("phone", v).maybeSingle();
    if (c) return { id: c.id, name: c.full_name, type: "candidate" };
  }
  for (const v of variants) {
    const { data: c } = await supabase.from("contacts").select("id, full_name").eq("phone", v).maybeSingle();
    if (c) return { id: c.id, name: c.full_name, type: "contact" };
  }
  return null;
}

// Insert one call_log row from an RC call-log API record. Returns "inserted",
// "skipped" (dedup hit / no id), or "error". Pulled out so we can run it
// against both extension- and account-level call-log responses.
async function processCallRecord(
  supabase: any,
  call: any,
  acct: any,
  results: any[],
): Promise<"inserted" | "skipped" | "error"> {
  const callId = call.id ?? call.sessionId;
  if (!callId) return "skipped";

  const { data: existing } = await supabase
    .from("call_logs")
    .select("id")
    .eq("external_call_id", callId)
    .maybeSingle();
  if (existing) return "skipped";

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
    return "error";
  }

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
      await processCallDeepgram.trigger(
        { call_log_id: inserted.id },
        { delay: "90s" },
      );
      logger.info("Triggered Deepgram transcription", { callId, callLogId: inserted.id });
    }
  }
  return "inserted";
}

// Walk a paginated RC call-log endpoint. Caller decides which path to hit
// (`extension/~/call-log` vs `account/~/call-log`) and what filter to apply.
async function walkCallLog(
  endpoint: string,
  token: string,
  since: string,
  acctLabel: string,
  filter: (call: any) => boolean,
  onCall: (call: any) => Promise<void>,
): Promise<void> {
  let page = 1;
  while (page <= 30) {
    const params = new URLSearchParams({
      type: "Voice",
      view: "Detailed",
      dateFrom: since,
      perPage: "100",
      page: String(page),
    });

    const logRes = await fetch(`${RC_SERVER}${endpoint}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!logRes.ok) {
      // 403 on account-level is expected when the JWT app lacks
      // ReadCallLog at account scope — log as info so it doesn't pollute
      // alerting; everything else is a real warning.
      const msg = `Call-log ${logRes.status} on ${endpoint}`;
      const meta = { account: acctLabel };
      if (logRes.status === 403) logger.info(msg, meta);
      else logger.warn(msg, meta);
      return;
    }

    const logData = await logRes.json();
    const records = (logData.records ?? []) as any[];
    logger.info(`${acctLabel} ${endpoint} page ${page}: ${records.length} calls`);

    for (const call of records) {
      if (filter(call)) await onCall(call);
    }
    if (records.length < 100) return;
    page++;
  }
}

async function runPoll(lookbackMinutes: number) {
  const supabase = getSupabaseAdmin();

  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, owner_user_id, account_label, rc_jwt, rc_extension, access_token, token_expires_at, metadata")
    .eq("provider", "sms")
    .eq("is_active", true)
    .not("rc_jwt", "is", null);

  if (!accounts?.length) {
    logger.info("No RC accounts found");
    return { calls_scanned: 0, calls_inserted: 0, calls_skipped: 0, lookback_minutes: lookbackMinutes, results: [] };
  }

  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  let totalProcessed = 0, totalInserted = 0, totalSkipped = 0;
  const results: any[] = [];

  for (const acct of accounts) {
    const token = await getToken(acct);
    if (!token) {
      logger.warn(`No token for ${acct.account_label}`);
      continue;
    }

    const tally = async (call: any) => {
      totalProcessed++;
      const result = await processCallRecord(supabase, call, acct, results);
      if (result === "inserted") totalInserted++;
      else totalSkipped++;
    };

    // 1) Extension-level call-log: covers calls dialed from / answered on
    //    this user's specific extension.
    await walkCallLog(
      "/restapi/v1.0/account/~/extension/~/call-log",
      token,
      since,
      acct.account_label,
      () => true,
      tally,
    );

    // 2) Account-level call-log: catches inbound calls routed via the main
    //    number / IVR / queue that never get recorded against the extension's
    //    own log. We filter to records whose extension matches this acct's
    //    rc_extension, and let dedup-by-external_call_id ignore overlaps.
    //    If the JWT lacks account-scope ReadCallLog (403), walkCallLog logs
    //    once and returns; this stays a best-effort backstop.
    if (acct.rc_extension) {
      const ext = String(acct.rc_extension);
      await walkCallLog(
        "/restapi/v1.0/account/~/call-log",
        token,
        since,
        acct.account_label,
        (call: any) =>
          String(call.extension?.extensionNumber ?? "") === ext ||
          String(call.extension?.id ?? "") === ext,
        tally,
      );
    }
  }

  logger.info("Poll RC calls complete", { totalProcessed, totalInserted, totalSkipped, lookbackMinutes });
  return {
    calls_scanned: totalProcessed,
    calls_inserted: totalInserted,
    calls_skipped: totalSkipped,
    lookback_minutes: lookbackMinutes,
    results,
  };
}

export const pollRcCalls = schedules.task({
  id: "poll-rc-calls",
  maxDuration: 120,
  // RC's call-log only surfaces a call after it ends, and `dateFrom` filters
  // by call *start* time. With a 10-min lookback, any call longer than the
  // poll cadence (5 min) silently misses the window. Use 4h so calls up to
  // ~4 hours long are still caught by the next poll. Dedup on
  // external_call_id keeps the redundant pages cheap.
  run: async () => runPoll(240),
});

/**
 * One-shot backfill task. Trigger from the dashboard with:
 *   { "lookback_minutes": 1440 }   // last 24h
 * Defaults to 60 minutes if no payload provided.
 */
export const backfillRcCalls = task({
  id: "backfill-rc-calls",
  maxDuration: 600,
  run: async (payload: { lookback_minutes?: number }) => {
    const minutes = payload?.lookback_minutes ?? 60;
    return runPoll(minutes);
  },
});
