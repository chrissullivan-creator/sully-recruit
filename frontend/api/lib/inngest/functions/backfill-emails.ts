import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import { normalizeEmail } from "../../../../src/trigger/lib/resume-parsing.js";
import { isMarketingEmail } from "../../../../src/trigger/lib/marketing-blocklist.js";
import { unipileFetch } from "../../../../src/trigger/lib/unipile-v2.js";
import { notifyError } from "../../../../src/trigger/lib/alerting.js";

/**
 * Backfill emails from Unipile every 5 minutes — safety net for missed
 * Unipile webhooks (process-unipile-event handles real-time delivery).
 *
 * Iterates every active integration_accounts row with
 * account_type='email' and a unipile_account_id, pulls the last 3 days
 * of email from `{account_id}/emails`, dedups by external_message_id,
 * and matches each email to a candidate/contact for the Inbox UI.
 *
 * Previously hit Microsoft Graph /me/mailFolders/{Inbox,SentItems}/messages
 * with a refresh-token rotation. The mailboxes themselves moved to
 * Unipile-hosted Outlook a while back (USE_UNIPILE_EMAIL=true) and the
 * Graph creds path lingered — this aligns inbound backfill with the
 * outbound send path that already runs through Unipile.
 */

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build email → entity map for matching inbound senders / outbound
 *  recipients to candidate or contact rows. */
async function buildEmailLookup(supabase: any) {
  const map = new Map<string, { type: "candidate" | "contact"; id: string; owner_user_id: string | null }>();
  const PAGE = 1000;
  const loadAll = async (table: "people" | "contacts") => {
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from(table)
        .select("id, email:primary_email, owner_user_id, type")
        .not("primary_email", "is", null)
        .neq("primary_email", "")
        .range(from, from + PAGE - 1);
      const rows = data ?? [];
      for (const c of rows) {
        const resolvedType: "candidate" | "contact" =
          table === "contacts"
            ? "contact"
            : (c as any).type === "client"
              ? "contact"
              : "candidate";
        const e = normalizeEmail(c.email);
        if (e) map.set(e, { type: resolvedType, id: c.id, owner_user_id: c.owner_user_id });
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  };
  await loadAll("people");
  await loadAll("contacts");
  return map;
}

/** Pick the first non-empty value across a list of candidate fields.
 *  Unipile email payload shapes vary a bit by provider (Outlook vs
 *  Gmail vs IMAP) and version — be tolerant of all of them. */
function pickStr(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

interface UnipileAttendee {
  identifier?: string;
  display_name?: string;
  email?: string;
}

interface UnipileEmail {
  id?: string;
  message_id?: string;
  provider_id?: string;
  internet_message_id?: string;
  subject?: string | null;
  body?: string | null;
  body_html?: string | null;
  body_preview?: string | null;
  is_outbound?: boolean;
  date?: string | null;
  timestamp?: string | null;
  sent_date?: string | null;
  received_date?: string | null;
  thread_id?: string | null;
  conversation_id?: string | null;
  from_attendee?: UnipileAttendee | null;
  to_attendees?: UnipileAttendee[] | null;
}

async function processAccount(
  supabase: any,
  account: any,
  emailLookup: Map<string, { type: "candidate" | "contact"; id: string; owner_user_id: string | null }>,
  dateFrom: string,
  dateTo: string,
  pageLimit: number,
  logger: any,
): Promise<{ inserted: number; skipped: number; unmatched: number; errors: number; pages: number }> {
  let inserted = 0,
    skipped = 0,
    unmatched = 0,
    errors = 0,
    pages = 0;
  const accountEmail = normalizeEmail(account.email_address);
  if (!accountEmail) return { inserted, skipped, unmatched, errors, pages };

  // Unipile v2 emails endpoint paginates with `cursor`; we cap at
  // pageLimit pages to bound runtime per cron tick.
  let cursor: string | undefined;
  while (pages < pageLimit) {
    let payload: any;
    try {
      payload = await unipileFetch(supabase, account.unipile_account_id, "emails", {
        method: "GET",
        query: {
          limit: 50,
          date_from: dateFrom,
          date_to: dateTo,
          ...(cursor ? { cursor } : {}),
        },
      });
    } catch (err: any) {
      logger.error(`Unipile emails fetch failed for ${account.email_address}`, { error: err.message });
      // Don't burn an email alert on Unipile-side 5xx internal errors —
      // they're not actionable for the recruiter (no auth or config to
      // fix), they self-heal, and the once-per-hour notifyError dedup
      // can still spam over a multi-hour Unipile incident. 4xx (and
      // any non-Unipile error shape) still alert at ERROR severity
      // because those usually mean a real auth / account / config
      // problem that needs fixing.
      const m = String(err?.message || "").match(/^Unipile\s+(\d{3})\b/);
      const status = m ? Number(m[1]) : null;
      const is5xx = status !== null && status >= 500 && status <= 599;
      if (!is5xx) {
        await notifyError({
          taskId: "backfill-emails",
          severity: "ERROR",
          error: err,
          context: { accountId: account.id, email: account.email_address, status },
        });
      }
      break;
    }
    pages++;
    const items: UnipileEmail[] = Array.isArray(payload)
      ? payload
      : (payload.items ?? payload.emails ?? payload.data ?? []);
    if (items.length === 0) break;

    const pageMessageIds = items
      .map((m) => m.id || m.message_id || m.provider_id || m.internet_message_id)
      .filter(Boolean) as string[];
    const existingIds = new Set<string>();
    if (pageMessageIds.length > 0) {
      const { data: existing } = await supabase
        .from("messages")
        .select("external_message_id")
        .in("external_message_id", pageMessageIds);
      for (const row of existing ?? []) {
        if (row.external_message_id) existingIds.add(row.external_message_id);
      }
    }

    for (const msg of items) {
      try {
        const externalMessageId = msg.id || msg.message_id || msg.provider_id || msg.internet_message_id;
        if (!externalMessageId) {
          skipped++;
          continue;
        }
        if (existingIds.has(externalMessageId)) {
          skipped++;
          continue;
        }

        const externalConversationId = pickStr(msg.thread_id, msg.conversation_id, externalMessageId) || externalMessageId;
        const subject = msg.subject ?? null;
        const fromAttendee = msg.from_attendee ?? null;
        const senderEmail = normalizeEmail(fromAttendee?.identifier ?? fromAttendee?.email ?? "");
        const senderName = pickStr(fromAttendee?.display_name);
        const toEmails = (msg.to_attendees ?? [])
          .map((r) => normalizeEmail(r?.identifier ?? r?.email ?? ""))
          .filter(Boolean) as string[];

        const isOutbound =
          typeof msg.is_outbound === "boolean"
            ? msg.is_outbound
            : (senderEmail === accountEmail);

        const matchEmail = isOutbound ? toEmails[0] : senderEmail;
        if (!matchEmail) {
          skipped++;
          continue;
        }

        if (!isOutbound && senderEmail === "messages-noreply@linkedin.com") {
          skipped++;
          continue;
        }
        if (isMarketingEmail(isOutbound ? null : senderEmail)) {
          skipped++;
          continue;
        }

        const entity = emailLookup.get(matchEmail);
        const candidateId = entity?.type === "candidate" ? entity.id : null;
        const contactId = entity?.type === "contact" ? entity.id : null;
        if (!entity) unmatched++;

        const sentAt = pickStr(msg.date, msg.timestamp, msg.sent_date);
        const receivedAt = pickStr(msg.received_date) ?? sentAt;
        const bodyText = stripHtml(msg.body_html ?? msg.body ?? msg.body_preview ?? "");
        const preview = (msg.body_preview ?? bodyText ?? "").slice(0, 500);

        let { data: conversation } = await supabase
          .from("conversations")
          .select("id")
          .eq("external_conversation_id", externalConversationId)
          .eq("integration_account_id", account.id)
          .maybeSingle();
        if (!conversation) {
          const { data: created } = await supabase
            .from("conversations")
            .insert({
              candidate_id: candidateId,
              contact_id: contactId,
              channel: "email",
              integration_account_id: account.id,
              external_conversation_id: externalConversationId,
              subject,
              last_message_preview: preview,
              last_message_at: receivedAt ?? sentAt,
              is_read: true,
              is_archived: false,
              assigned_user_id: entity?.owner_user_id ?? account.owner_user_id,
            })
            .select("id")
            .single();
          conversation = created;
        }
        if (!conversation) {
          errors++;
          continue;
        }

        const { error: msgErr } = await supabase.from("messages").insert({
          conversation_id: conversation.id,
          candidate_id: candidateId,
          contact_id: contactId,
          channel: "email",
          direction: isOutbound ? "outbound" : "inbound",
          message_type: "email",
          external_message_id: externalMessageId,
          external_conversation_id: externalConversationId,
          subject,
          body: bodyText,
          sender_name: senderName,
          sender_address: isOutbound ? accountEmail : (senderEmail || null),
          recipient_address: isOutbound ? matchEmail : accountEmail,
          sent_at: sentAt,
          received_at: receivedAt,
          integration_account_id: account.id,
          provider: "unipile",
          is_read: true,
        });
        if (msgErr) {
          errors++;
          continue;
        }
        inserted++;
      } catch (err: any) {
        logger.error("Message processing error", { error: err.message });
        errors++;
      }
    }

    cursor = payload.cursor || payload.next_cursor || payload.next || undefined;
    if (!cursor) break;
  }
  return { inserted, skipped, unmatched, errors, pages };
}

export const backfillEmails = inngest.createFunction(
  { id: "backfill-emails", name: "Backfill emails from Unipile (Inngest)" },
  { cron: "1-56/5 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const daysBack = 3;
    const dateFrom = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = new Date().toISOString();
    const maxPages = 5; // hard cap per account per tick

    const emailLookup = await buildEmailLookup(supabase);
    logger.info(`Loaded ${emailLookup.size} known emails for matching`);

    const { data: accounts, error: acctErr } = await supabase
      .from("integration_accounts")
      .select("id, email_address, owner_user_id, unipile_account_id, unipile_provider")
      .eq("account_type", "email")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (acctErr) {
      logger.error("Account lookup failed", { error: acctErr.message });
      await notifyError({ taskId: "backfill-emails", error: acctErr, severity: "ERROR" });
      return { error: acctErr.message };
    }
    if (!accounts?.length) {
      logger.warn("No Unipile email accounts configured");
      return { error: "no_unipile_email_accounts" };
    }

    const results = [];
    for (const account of accounts) {
      try {
        const result = await processAccount(
          supabase,
          account,
          emailLookup,
          dateFrom,
          dateTo,
          maxPages,
          logger,
        );
        results.push({ email: account.email_address, ...result });
        logger.info(`Processed ${account.email_address}`, result);
      } catch (err: any) {
        logger.error("Account processing error", { email: account.email_address, error: err.message });
        results.push({ email: account.email_address, error: err.message });
        await notifyError({
          taskId: "backfill-emails",
          severity: "WARN",
          error: err,
          context: { accountId: account.id, email: account.email_address },
        });
      }
    }

    const totalInserted = results.reduce((s, r: any) => s + (r.inserted ?? 0), 0);
    const totalUnmatched = results.reduce((s, r: any) => s + (r.unmatched ?? 0), 0);
    logger.info("Email backfill complete", { totalInserted, totalUnmatched, accounts: results.length });

    return { dateFrom, dateTo, knownEmails: emailLookup.size, results, totalInserted, totalUnmatched };
  },
);
