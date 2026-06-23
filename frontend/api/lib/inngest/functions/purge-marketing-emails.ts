import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import {
  MARKETING_DOMAINS,
  MARKETING_SENDER_PATTERNS,
} from "../../../../src/server-lib/marketing-blocklist.js";

/**
 * Purge marketing/newsletter emails from the messages + conversations
 * tables. Only acts on UNMATCHED messages (candidate_id and contact_id
 * both null) — never deletes a message tied to a real person, even if
 * the sender shape looks marketing-y.
 *
 * Daily at 04:00 UTC. Only deletes marketing mail older than a 3-day
 * retention window (gated on created_at), so there's a short buffer to
 * catch a mis-flagged message before it's gone. Ported from
 * `src/trigger/purge-marketing-emails.ts` — Inngest is the only scheduler
 * now. The blocklist + isMarketingEmail helper moved to
 * `src/server-lib/marketing-blocklist.ts` so the backfill-emails Inngest
 * function can share it.
 */
export const purgeMarketingEmails = inngest.createFunction(
  { id: "purge-marketing-emails", name: "Purge marketing emails (Inngest)" },
  { cron: "0 4 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    // 3-day retention: leave very recent marketing in place briefly in case
    // it's mis-flagged or gets tagged to a person, then purge.
    const RETENTION_DAYS = 3;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const domainConditions = MARKETING_DOMAINS.map((d) => {
      if (d.includes("@")) return `sender_address.eq.${d}`;
      return `sender_address.ilike.%@${d},sender_address.ilike.%@%.${d}`;
    }).join(",");

    const prefixConditions = MARKETING_SENDER_PATTERNS.map(
      (p) => `sender_address.ilike.${p}%`,
    ).join(",");

    const { data: junkMessages, error } = await supabase
      .from("messages")
      .select("id, conversation_id, sender_address")
      .is("candidate_id", null)
      .is("contact_id", null)
      .lt("created_at", cutoff)
      .or(`${domainConditions},${prefixConditions}`)
      .limit(1000);

    if (error) {
      logger.error("Query error", { error: error.message });
      throw error;
    }

    if (!junkMessages?.length) {
      logger.info("No marketing emails to purge");
      return { deleted: 0 };
    }

    const messageIds = junkMessages.map((m: any) => m.id);
    const conversationIds = [...new Set(junkMessages.map((m: any) => m.conversation_id).filter(Boolean))];

    const sampleSenders = [...new Set(
      junkMessages.slice(0, 10).map((m: any) => m.sender_address).filter(Boolean),
    )];
    logger.info("Purging marketing emails", {
      count: messageIds.length,
      sampleSenders,
      conversationIds: conversationIds.length,
    });

    const { error: delErr } = await supabase
      .from("messages")
      .delete()
      .in("id", messageIds);

    if (delErr) {
      logger.error("Delete messages error", { error: delErr.message });
      throw delErr;
    }

    logger.info(`Deleted ${messageIds.length} marketing messages`);

    let orphanedConvs = 0;
    for (const convId of conversationIds) {
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", convId);

      if (count === 0) {
        await supabase.from("conversations").delete().eq("id", convId);
        orphanedConvs++;
      }
    }

    logger.info("Purge complete", {
      messagesDeleted: messageIds.length,
      conversationsDeleted: orphanedConvs,
    });

    return {
      messagesDeleted: messageIds.length,
      conversationsDeleted: orphanedConvs,
    };
  },
);
