import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

// Purge marketing/newsletter emails from the messages + conversations tables.
// Runs daily at 4 AM UTC. Also used by backfill-emails to skip junk on ingest.
//
// Schedule: 0 4 * * * (daily at 4 AM UTC)

// ── Marketing domain blocklist ──────────────────────────────────────────────
// Emails from these domains are never from candidates/contacts.
// Subdomains match too (e.g. "notification.capitalone.com" matches "capitalone.com").
export const MARKETING_DOMAINS = [
  // Newsletters & media
  "onlyinyourstate.com",
  "interactive.wsj.com",
  "smartbrief.com",
  "thecitywire.com",
  "axios.com",
  "response.cnbc.com",
  "news.bloomberg.com",
  "message.bloomberg.com",
  "e.crainalerts.com",
  "substack.com",
  "mail.beehiiv.com",
  "news.alpha-maven.com",

  // Marketing & promo
  "campaign.masterlearning.com",
  "email.bestbuy.com",
  "email.quince.com",
  "draftkings.com",
  "d.email.draftkings.com",
  "ma.sb.fanduel.com",
  "newsletter.pilotflyingj.com",
  "nanews.e.afterpay.com",
  "ldry.fbmta.com",
  "n.thepaystubs.com",
  "email.gasbuddy.com",

  // Financial notifications (not recruiter comms)
  "notification.capitalone.com",
  "email.schwab.com",
  "em1.turbotax.intuit.com",
  "chase.com",

  // Platform notifications (not candidate replies)
  "noreply@github.com",
  "notifications@vercel.com",
  "mail.replit.com",
  "namecheap.com",

  // LinkedIn notification digests (NOT hit-reply which are real replies)
  "messaging-digest-noreply@linkedin.com",
  "jobalerts-noreply@linkedin.com",
  "notifications@linkedin.com",
  "news@linkedin.com",
  // Note: messages-noreply@linkedin.com is handled specially in backfill-emails.ts
  // — InMail replies (sender_name "X via LinkedIn") are kept as channel=linkedin,
  // — marketing (sender_name "LinkedIn" or "LinkedIn Recruiter") are blocked there.

  // Noreply / system
  "noreply@email.openai.com",
  "sign.plus",
  "jooble.org",
  "mms.uscc.net",
];

// Sender address patterns that are always marketing
export const MARKETING_SENDER_PATTERNS = [
  "noreply@",
  "no-reply@",
  "newsletter@",
  "marketing@",
  "notifications@",
  "digest@",
  "updates@",
  "promo@",
  "deals@",
  "offers@",
  "info@",
  "subscribe@",
  "unsubscribe@",
  "mailer@",
  "bounce@",
  "donotreply@",
  "do-not-reply@",
];

export function isMarketingEmail(senderAddress: string | null): boolean {
  if (!senderAddress) return false;
  const lower = senderAddress.toLowerCase().trim();

  // Check exact domain or subdomain match
  const domain = lower.split("@")[1];
  if (domain) {
    for (const blocked of MARKETING_DOMAINS) {
      if (domain === blocked || domain.endsWith("." + blocked)) return true;
    }
  }

  // Check full address match (for specific noreply addresses)
  for (const blocked of MARKETING_DOMAINS) {
    if (blocked.includes("@") && lower === blocked) return true;
  }

  // Check sender prefix patterns
  for (const pattern of MARKETING_SENDER_PATTERNS) {
    if (lower.startsWith(pattern)) return true;
  }

  return false;
}

export const purgeMarketingEmails = schedules.task({
  id: "purge-marketing-emails",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Build OR conditions for domain matching
    const domainConditions = MARKETING_DOMAINS.map((d) => {
      if (d.includes("@")) {
        return `sender_address.eq.${d}`;
      }
      return `sender_address.ilike.%@${d},sender_address.ilike.%@%.${d}`;
    }).join(",");

    const prefixConditions = MARKETING_SENDER_PATTERNS.map(
      (p) => `sender_address.ilike.${p}%`,
    ).join(",");

    // Find marketing messages (unmatched only — never delete matched messages)
    const { data: junkMessages, error } = await supabase
      .from("messages")
      .select("id, conversation_id")
      .is("candidate_id", null)
      .is("contact_id", null)
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

    // Delete messages
    const { error: delErr } = await supabase
      .from("messages")
      .delete()
      .in("id", messageIds);

    if (delErr) {
      logger.error("Delete messages error", { error: delErr.message });
      throw delErr;
    }

    logger.info(`Deleted ${messageIds.length} marketing messages`);

    // Clean up orphaned conversations (no remaining messages)
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
});
