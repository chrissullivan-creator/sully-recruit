/**
 * Marketing / newsletter / notification email blocklist.
 *
 * Used by:
 *   - api/lib/inngest/functions/purge-marketing-emails.ts (daily sweep)
 *   - api/lib/inngest/functions/backfill-emails.ts        (skip on ingest)
 *
 * Subdomain match counts (e.g. `notification.capitalone.com` matches
 * `capitalone.com`). Full addresses with `@` match exact sender only.
 */

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

  // LinkedIn bulk subdomains (the per-mailbox *@linkedin.com noise is handled
  // by the dedicated rule in isMarketingEmail so real replies/people survive).
  "em.linkedin.com",
  "cs.linkedin.com",

  // Newsletters / recruiting-industry / promo (from inbox sweep 2026-06)
  "ccsend.com",
  "shared1.ccsend.com",
  "ziprecruiter.com",
  "efinancialcareers.com",
  "emails.efinancialcareers.com",
  "topechelon.com",
  "email-whitepages.com",
  "learnbfsi.com",
  "staffinghub.com",
  "smartlead-team.com",
  "emeraldeex.com",
  "send.zapier.com",
  "mail.clickup.com",
  "mail.anthropic.com",
  "e.crainwebinars.com",
  "birds.cornell.edu",
  // Retail / travel / finance promos & notifications
  "emailinfo.buffalowildwings.com",
  "email.petermillar.com",
  "info6.citi.com",
  "mail.quince.com",
  "notice.loanstripe.com",
  "email.flybreeze.com",
  "email.enterprise.com",
  "eg.expedia.com",
  "mc.ihg.com",
  "alerts.lendingtree.com",
  "news.hims.com",
  "email-marriott.com",
  "nytdirect@nytimes.com",
  "uber@uber.com",
];

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
  "alerts@",
  "notify@",
  "noreply-",
  "press@",
  "mailer-daemon@",
  "postmaster@",
];

export function isMarketingEmail(senderAddress: string | null): boolean {
  if (!senderAddress) return false;
  const lower = senderAddress.toLowerCase().trim();

  const domain = lower.split("@")[1];
  if (domain) {
    for (const blocked of MARKETING_DOMAINS) {
      if (domain === blocked || domain.endsWith("." + blocked)) return true;
    }
  }

  for (const blocked of MARKETING_DOMAINS) {
    if (blocked.includes("@") && lower === blocked) return true;
  }

  for (const pattern of MARKETING_SENDER_PATTERNS) {
    if (lower.startsWith(pattern)) return true;
  }

  // Every email from LinkedIn is noise (including hit-reply@linkedin.com) — the
  // real conversations come through the LinkedIn message channel, not these
  // email notifications/relays. Blocks linkedin.com + all subdomains.
  if (domain && (domain === "linkedin.com" || domain.endsWith(".linkedin.com"))) {
    return true;
  }

  return false;
}
