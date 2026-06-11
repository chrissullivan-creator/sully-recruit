import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";
import { fetchRcCallLog } from "../../../../src/server-lib/rc-call-log.js";
import { fetchWithRetry } from "../../../../src/server-lib/fetch-retry.js";

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
 * Scope: we poll the **account-level** call log (`/account/~/call-log`),
 * which returns every extension's calls when the connected JWT is an
 * account admin/owner — so one seat captures the whole company. Each call
 * is attributed to the right person by matching its internal extension
 * (top-level party or `legs`) against `metadata.rc_extension_id` on the
 * integration_accounts rows. Calls whose internal extension isn't mapped to
 * a tracked user are skipped (keeps unrelated company lines out). If the
 * JWT isn't account-admin, we fall back to the per-extension call log
 * (`/account/~/extension/~/call-log`) — the legacy single-seat behavior.
 *
 * Ported from `src/trigger/poll-rc-calls.ts` — Inngest is the only
 * scheduler now. The transcription dispatch sends the canonical Inngest
 * `call/transcribe.requested` event.
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

  const res = await fetchWithRetry(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  }, { label: "rc-token" });
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

/**
 * Find the tracked internal extension for a call. RC puts the internal
 * party at the top level for outbound (`from`) but for inbound the answering
 * extension only shows up in `legs`, so we scan every party and return the
 * first extension that maps to a tracked user. Returns null when no tracked
 * extension is involved (call belongs to an untracked line — skip it).
 */
function resolveOwnerExtension(call: any, knownExts: Set<string>): string | null {
  const parties: any[] = [call.from, call.to];
  for (const leg of call.legs ?? []) {
    parties.push(leg.from, leg.to);
  }
  for (const p of parties) {
    const ext = p?.extensionId ? String(p.extensionId) : null;
    if (ext && knownExts.has(ext)) return ext;
  }
  return null;
}

/** Any internal extension id present on a call — for logging untracked lines. */
function candidateInternalExt(call: any): string | null {
  const parties: any[] = [call.from, call.to];
  for (const leg of call.legs ?? []) parties.push(leg.from, leg.to);
  for (const p of parties) {
    if (p?.extensionId) return String(p.extensionId);
  }
  return null;
}

/**
 * Dedup + insert/reconcile a single RC call-log record under `ownerId`,
 * queuing a transcription event for new (or freshly-lengthened) completed
 * calls ≥30s. Returns counters so the caller can tally the run.
 */
async function processCall(
  supabase: any,
  call: any,
  ownerId: string,
  transcribeEvents: Array<{ name: "call/transcribe.requested"; data: { call_log_id: string } }>,
  logger: any,
): Promise<{ inserted: number; skipped: number; result?: any }> {
  const callId = call.id ?? call.sessionId;
  if (!callId) return { inserted: 0, skipped: 1 };

  const duration = call.duration ?? 0;

  // Reconciliation rule: the RC webhook fires while a call is still in
  // progress (often `duration: 0` or a partial number), and call_logs gets
  // stamped with that value. The poll runs later against the call-log REST
  // API and has the *final* duration. If the existing row has a shorter
  // duration than the polled one, update it (and stamp ended_at + status to
  // match). Otherwise skip.
  const { data: existing } = await supabase
    .from("call_logs")
    .select("id, duration_seconds, ended_at")
    .eq("external_call_id", callId)
    .maybeSingle();

  if (existing) {
    const existingDur = existing.duration_seconds ?? 0;
    if (duration > existingDur || (!existing.ended_at && duration > 0)) {
      const startedAt = call.startTime ? new Date(call.startTime).toISOString() : null;
      const endedAt =
        startedAt && duration > 0
          ? new Date(new Date(call.startTime).getTime() + duration * 1000).toISOString()
          : null;
      let status = "completed";
      if (call.result === "Missed") status = "missed";
      else if (call.result === "Voicemail") status = "voicemail";
      else if (duration === 0) status = "missed";
      const { error: updateErr } = await supabase
        .from("call_logs")
        .update({
          duration_seconds: duration,
          ended_at: endedAt,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (updateErr) {
        logger.error(`Update error for call ${callId}`, { error: updateErr.message });
        return { inserted: 0, skipped: 1 };
      }
      logger.info("Reconciled call duration", { callId, from: existingDur, to: duration });

      // If the duration just crossed the transcription threshold (>=30s) AND
      // the call is completed AND we haven't already produced ai_call_notes
      // for it, dispatch transcription so the AI extraction + candidate
      // auto-fill runs.
      if (duration >= 30 && status === "completed" && existingDur < 30) {
        const { data: existingNotes } = await supabase
          .from("ai_call_notes")
          .select("id")
          .eq("external_call_id", callId)
          .maybeSingle();
        if (!existingNotes) {
          transcribeEvents.push({ name: "call/transcribe.requested", data: { call_log_id: existing.id } });
        }
      }
      return { inserted: 1, skipped: 0 };
    }
    return { inserted: 0, skipped: 1 };
  }

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
    owner_id: ownerId,
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
    return { inserted: 0, skipped: 1 };
  }

  if (duration >= 30 && status === "completed") {
    const { data: inserted } = await supabase
      .from("call_logs")
      .select("id")
      .eq("external_call_id", callId)
      .maybeSingle();
    if (inserted?.id) {
      transcribeEvents.push({ name: "call/transcribe.requested", data: { call_log_id: inserted.id } });
    }
  }

  return {
    inserted: 1,
    skipped: 0,
    result: {
      call_id: callId,
      direction,
      duration,
      status,
      phone: otherPhone,
      entity: entity?.name ?? "unlinked",
    },
  };
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

  // extensionId → owner_user_id, so account-level calls land on the right
  // person regardless of which seat's JWT did the polling.
  const extToOwner = new Map<string, string>();
  for (const a of accounts) {
    const ext = a.metadata?.rc_extension_id;
    if (ext && a.owner_user_id) extToOwner.set(String(ext), a.owner_user_id);
  }
  const knownExts = new Set(extToOwner.keys());

  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  let totalProcessed = 0,
    totalInserted = 0,
    totalSkipped = 0;
  const results: any[] = [];
  const transcribeEvents: Array<{ name: "call/transcribe.requested"; data: { call_log_id: string } }> = [];

  const unmappedExts = new Set<string>();

  for (const acct of accounts) {
    const token = await getToken(supabase, acct, logger);
    if (!token) {
      logger.warn(`No token for ${acct.account_label}`);
      continue;
    }

    // Account-level first (one admin JWT covers every extension), falling back
    // to per-extension for a non-admin seat — see fetchRcCallLog. `account`
    // scope attributes via the extension map; `extension` scope attributes
    // everything to this seat's owner.
    const { records, scope, authError } = await fetchRcCallLog(token, {
      dateFrom: since,
      label: `rc-poll:${acct.account_label}`,
    });

    if (authError) {
      // Both account- and extension-scope rejected the token — genuine re-auth.
      logger.error(
        `Call-log ${authError.status} for ${acct.account_label} (account+extension both rejected)`,
        { body: authError.body },
      );
      await notifyError({
        taskId: "poll-rc-calls",
        severity: "ERROR",
        error: new Error(`RC call-log ${authError.status} for ${acct.account_label} — re-auth required: ${authError.body}`),
        context: { accountId: acct.id, accountLabel: acct.account_label, status: authError.status },
      });
      continue;
    }

    logger.info(`${acct.account_label} (${scope}) returned ${records.length} calls since ${since}`);

    for (const call of records) {
      // Whose call is it? On account scope, derive from the internal extension
      // and skip untracked lines; on extension scope every record is this seat's.
      let ownerId: string | undefined;
      if (scope === "account") {
        const ext = resolveOwnerExtension(call, knownExts);
        ownerId = ext ? extToOwner.get(ext) : undefined;
        if (!ownerId) {
          totalSkipped++;
          const cand = candidateInternalExt(call);
          if (cand) unmappedExts.add(cand);
          continue; // call on an extension we don't track
        }
      } else {
        ownerId = acct.owner_user_id;
      }

      totalProcessed++;
      const r = await processCall(supabase, call, ownerId!, transcribeEvents, logger);
      totalInserted += r.inserted;
      totalSkipped += r.skipped;
      if (r.result) results.push({ ...r.result, account: acct.account_label });
    }
  }

  if (unmappedExts.size > 0) {
    logger.warn(
      "poll-rc-calls: skipped calls on untracked RC extensions — set metadata.rc_extension_id on the matching integration_account to ingest them",
      { extensions: [...unmappedExts] },
    );
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
  // Lookback of 60 min, polled every 5 min, gives each call up to a
  // dozen reconciliation chances before its startTime ages out of the
  // RC query window. Calls longer than the lookback used to drop
  // permanently because the webhook stamped a partial duration and
  // the poll never saw them again. Combined with the duration-
  // reconciliation fix in #261, a call of any length up to ~60 min
  // now lands with its final duration.
  async ({ logger }) => runPoll(60, logger),
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
