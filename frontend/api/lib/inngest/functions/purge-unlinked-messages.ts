import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";

/**
 * Rolling 30-day retention for UNLINKED messages.
 *
 * The webhook processors now persist inbound messages from unknown
 * senders (no candidate/contact match) so they show up in the inbox's
 * "Other" view and are searchable. To keep the messages table from
 * growing without bound, this cron deletes unlinked messages
 * (candidate_id AND contact_id both null) older than 30 days, then
 * removes any conversation shell that is left empty AND is itself
 * unlinked. Messages tied to a real person are never touched — they
 * stay forever.
 *
 * Runs daily at 04:30 UTC — just after purge-marketing-emails (04:00)
 * so the cheap blocklist sweep clears obvious junk first.
 */

const RETENTION_DAYS = 30;
const BATCH_SIZE = 1000;
const MAX_BATCHES = 50; // safety cap → up to 50k rows per run

export const purgeUnlinkedMessages = inngest.createFunction(
  { id: "purge-unlinked-messages", name: "Purge unlinked messages >30d (Inngest)" },
  { cron: "30 4 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    let messagesDeleted = 0;
    const touchedConversations = new Set<string>();

    for (let i = 0; i < MAX_BATCHES; i++) {
      const { data: batch, error } = await supabase
        .from("messages")
        .select("id, conversation_id")
        .is("candidate_id", null)
        .is("contact_id", null)
        .lt("created_at", cutoff)
        .limit(BATCH_SIZE);

      if (error) {
        logger.error("Unlinked purge query error", { error: error.message });
        throw error;
      }
      if (!batch?.length) break;

      const ids = batch.map((m: any) => m.id);
      for (const m of batch) {
        if (m.conversation_id) touchedConversations.add(m.conversation_id);
      }

      const { error: delErr } = await supabase.from("messages").delete().in("id", ids);
      if (delErr) {
        logger.error("Unlinked purge delete error", { error: delErr.message });
        throw delErr;
      }

      messagesDeleted += ids.length;
      if (batch.length < BATCH_SIZE) break;
    }

    // Clean up conversation shells that are now empty AND not tied to a
    // person. A conversation can legitimately keep messages newer than
    // the cutoff (recent unknown sender) — those are left alone.
    let conversationsDeleted = 0;
    for (const convId of touchedConversations) {
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", convId);
      if (count && count > 0) continue;

      const { data: conv } = await supabase
        .from("conversations")
        .select("id, candidate_id, contact_id")
        .eq("id", convId)
        .maybeSingle();

      if (conv && !conv.candidate_id && !conv.contact_id) {
        await supabase.from("conversations").delete().eq("id", convId);
        conversationsDeleted++;
      }
    }

    logger.info("Unlinked message purge complete", {
      messagesDeleted,
      conversationsDeleted,
      cutoff,
    });

    return { messagesDeleted, conversationsDeleted };
  },
);
