import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { unipileFetch, canonicalChannel } from "./lib/unipile-v2";

/**
 * One-off (idempotent) reclassify pass: re-pull every LinkedIn
 * conversation from Unipile v2 to read its real `content_type` +
 * `folder`, then re-stamp `conversations.channel`, `messages.channel`
 * and `conversations.content_type`.
 *
 * Why: the webhook never persisted these signals before today, so
 * historical rows for Chris/Nancy are split between "linkedin" and
 * "linkedin_recruiter" by inference (subject heuristic, account_type
 * fallback) — neither of which is reliable. The Unipile chat
 * object's `content_type='inmail'` and `folder` array are the
 * canonical InMail markers per the unipile-node-sdk types.
 *
 * Modes:
 *   - Trigger one-off via the Trigger.dev dashboard:
 *       task `reclassify-linkedin-chats-once`, no payload.
 *   - Or schedule it (cron) — re-runs are cheap because we skip rows
 *     whose content_type is already set.
 *
 * Strategy:
 *   1. Find LinkedIn conversations that don't have content_type set
 *      yet (one-off mode) or all of them (force=true payload).
 *   2. Group by integration_account so we hit Unipile with the right
 *      auth/account_id.
 *   3. For each, GET /v2/{account_id}/chats/{external_conversation_id}
 *   4. Read content_type and folder; classify via canonicalChannel.
 *   5. UPDATE the conversation + every message row inside it.
 *
 * Rate-limited at ~3 req/s per account to stay polite with Unipile.
 */

interface ReclassifyPayload {
  /** Re-stamp every row even if content_type is already populated. */
  force?: boolean;
  /** Hard cap rows per run so we don't OOM on a 12k-conv account. */
  limit?: number;
}

const DEFAULT_LIMIT = 5_000;
const PER_REQUEST_DELAY_MS = 333;

async function reclassifyOnce(payload: ReclassifyPayload = {}) {
  const supabase = getSupabaseAdmin();
  const force = !!payload.force;
  const limit = payload.limit ?? DEFAULT_LIMIT;

  // Pull candidates: LinkedIn conversations that still need an answer.
  let query = supabase
    .from("conversations")
    .select("id, external_conversation_id, integration_account_id, channel, content_type")
    .in("channel", ["linkedin", "linkedin_recruiter"])
    .not("external_conversation_id", "is", null)
    .not("integration_account_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (!force) query = query.is("content_type", null);

  const { data: convs, error } = await query;
  if (error) throw new Error(`Conversation lookup failed: ${error.message}`);
  if (!convs?.length) {
    logger.info("Nothing to reclassify", { force, limit });
    return { scanned: 0, updated: 0, errors: 0 };
  }

  // Cache integration_account → unipile_account_id so we don't query
  // for the same recruiter 3,500 times.
  const acctIds = Array.from(new Set(convs.map((c) => c.integration_account_id))) as string[];
  const { data: acctRows } = await supabase
    .from("integration_accounts")
    .select("id, unipile_account_id")
    .in("id", acctIds);
  const acctMap = new Map<string, string>();
  for (const row of acctRows ?? []) {
    if (row.unipile_account_id) acctMap.set(row.id, row.unipile_account_id);
  }

  let updated = 0;
  let errors = 0;
  let skipped = 0;

  for (const conv of convs) {
    const unipileAcctId = acctMap.get(conv.integration_account_id);
    if (!unipileAcctId) { skipped++; continue; }

    try {
      const chat: any = await unipileFetch(
        supabase,
        unipileAcctId,
        `chats/${encodeURIComponent(conv.external_conversation_id!)}`,
        { method: "GET" },
      );

      const contentType = String(chat.content_type ?? "").toLowerCase() || null;
      const folders: string[] = (chat.folder ?? []).map((f: any) => String(f).toUpperCase());
      const isInMail =
        contentType === "inmail" ||
        folders.includes("INBOX_LINKEDIN_RECRUITER");
      const newChannel = canonicalChannel(isInMail ? "linkedin_recruiter" : "linkedin");

      const needsChannelChange = newChannel !== conv.channel;
      const needsContentTypeStamp = (contentType ?? null) !== (conv.content_type ?? null);
      if (!needsChannelChange && !needsContentTypeStamp) { skipped++; }

      if (needsContentTypeStamp || needsChannelChange) {
        await supabase
          .from("conversations")
          .update({
            channel: newChannel,
            content_type: contentType,
            updated_at: new Date().toISOString(),
          } as any)
          .eq("id", conv.id);
      }
      // Keep messages in sync — searches/filters elsewhere read messages.channel.
      if (needsChannelChange) {
        await supabase
          .from("messages")
          .update({ channel: newChannel } as any)
          .eq("conversation_id", conv.id);
      }
      if (needsChannelChange || needsContentTypeStamp) updated++;
    } catch (err: any) {
      // 404 = chat deleted on Unipile's side; no update we can make.
      // Anything else logged but non-fatal so the sweep keeps moving.
      const msg = err.message || String(err);
      if (/\b404\b/.test(msg)) {
        skipped++;
      } else {
        errors++;
        logger.warn("Chat fetch failed", { convId: conv.id, error: msg });
      }
    }

    // Light per-request delay — Unipile is generous but not unlimited.
    await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
  }

  const summary = { scanned: convs.length, updated, errors, skipped, force };
  logger.info("Reclassify pass complete", summary);
  return summary;
}

/** Manual one-shot trigger — fire from the Trigger.dev dashboard. */
export const reclassifyLinkedinChatsOnce = task({
  id: "reclassify-linkedin-chats-once",
  maxDuration: 540,
  retry: { maxAttempts: 1 },
  run: async (payload: ReclassifyPayload) => reclassifyOnce(payload),
});

/** Daily schedule — picks up any rows that arrived before content_type
 *  capture lands or that the webhook missed. Skips rows already stamped. */
export const reclassifyLinkedinChatsDaily = schedules.task({
  id: "reclassify-linkedin-chats-daily",
  cron: "0 6 * * *", // 06:00 UTC every day
  maxDuration: 540,
  run: async () => reclassifyOnce({ limit: 1_500 }),
});
