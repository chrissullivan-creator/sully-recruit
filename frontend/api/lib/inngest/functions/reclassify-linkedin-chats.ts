import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { unipileFetch, canonicalChannel } from "../../../../src/server-lib/unipile-v2.js";

/**
 * Re-pull every LinkedIn conversation from Unipile v2 to read its real
 * `content_type` + `folder`, then re-stamp `conversations.channel`,
 * `messages.channel` and `conversations.content_type`.
 *
 * Why: webhooks didn't always persist these signals, so historical rows
 * are split between "linkedin" and "linkedin_recruiter" by inference
 * (subject heuristic, account_type fallback) — neither of which is
 * reliable. The chat object's `content_type='inmail'` and `folder` array
 * are the canonical InMail markers per the unipile-node-sdk types.
 *
 * Daily at 06:00 UTC. Re-runs are cheap because we skip rows whose
 * content_type is already set. Also exposed as an event-triggered
 * function for one-off forced re-classifications.
 *
 * Ported from `src/trigger/reclassify-linkedin-chats.ts`. Inngest is
 * the only scheduler now.
 */

interface ReclassifyPayload {
  /** Re-stamp every row even if content_type is already populated. */
  force?: boolean;
  /** Hard cap rows per run so we don't OOM on a 12k-conv account. */
  limit?: number;
}

const DEFAULT_LIMIT = 5_000;
const CONCURRENCY = 4;

async function reclassifyOnce(payload: ReclassifyPayload, logger: any) {
  const supabase = getSupabaseAdmin();
  const force = !!payload.force;
  const limit = payload.limit ?? DEFAULT_LIMIT;

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

  type Outcome = "updated" | "skipped" | "errored";
  const processOne = async (conv: typeof convs[number]): Promise<Outcome> => {
    const unipileAcctId = acctMap.get(conv.integration_account_id);
    if (!unipileAcctId) return "skipped";

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
      if (needsChannelChange) {
        await supabase
          .from("messages")
          .update({ channel: newChannel } as any)
          .eq("conversation_id", conv.id);
      }
      if (needsChannelChange || needsContentTypeStamp) return "updated";
      return "skipped";
    } catch (err: any) {
      const msg = err.message || String(err);
      if (/\b404\b/.test(msg)) return "skipped";
      logger.warn("Chat fetch failed", { convId: conv.id, error: msg });
      return "errored";
    }
  };

  for (let i = 0; i < convs.length; i += CONCURRENCY) {
    const batch = convs.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(batch.map(processOne));
    for (const o of outcomes) {
      if (o === "updated") updated++;
      else if (o === "skipped") skipped++;
      else errors++;
    }
  }

  const summary = { scanned: convs.length, updated, errors, skipped, force };
  logger.info("Reclassify pass complete", summary);
  return summary;
}

export const reclassifyLinkedinChatsDaily = inngest.createFunction(
  { id: "reclassify-linkedin-chats-daily", name: "Reclassify LinkedIn chats (daily, Inngest)" },
  { cron: "0 6 * * *" },
  async ({ logger }) => reclassifyOnce({ limit: 1_500 }, logger),
);

/**
 * One-off event-triggered version for manual reclassification runs.
 * Send via:
 *   await inngest.send({
 *     name: "ops/reclassify-linkedin-chats.requested",
 *     data: { force: true, limit: 5000 },
 *   });
 */
export const reclassifyLinkedinChatsOnce = inngest.createFunction(
  { id: "reclassify-linkedin-chats-once", name: "Reclassify LinkedIn chats (one-off, Inngest)" },
  { event: "ops/reclassify-linkedin-chats.requested" },
  async ({ event, logger }) => reclassifyOnce(event.data ?? {}, logger),
);
