import { inngest } from "../client.js";
import { getSupabaseAdmin, getAppSetting } from "../../../../src/server-lib/supabase.js";
import { normalizeEmail } from "../../../../src/server-lib/resume-parsing.js";
import { isMarketingEmail } from "../../../../src/server-lib/marketing-blocklist.js";
import { unipileFetch, unipileFetchV2 } from "../../../../src/server-lib/unipile-v2.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

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
      //
      // Special case: api/inactive_subscription is a 403 but it's a
      // Unipile billing/seat state — fixed in their dashboard, not
      // ours. Once the seat is reactivated the cron auto-resumes, so
      // we don't need hourly emails reminding us. The error still
      // shows in the Inngest run history.
      const m = String(err?.message || "").match(/^Unipile\s+(\d{3})\b/);
      const status = m ? Number(m[1]) : null;
      const is5xx = status !== null && status >= 500 && status <= 599;
      const isInactiveSubscription = /api\/inactive_subscription/.test(String(err?.message || ""));
      if (!is5xx && !isInactiveSubscription) {
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

/**
 * v2 variant of processAccount. The OUTLOOK mailboxes were re-linked onto the
 * Unipile **v2** app (api.unipile.com/v2), so the v1 DSN workspace this cron
 * used returns an empty account list and every pull 404'd — that's what
 * silently froze inbound email. This pulls from
 * `GET {v2Base}/{acc_xxx}/emails` via unipileFetchV2 and maps the v2 Email
 * shape ({ from:[{email,display_name}], to:[], cc:[], subject, body, snippet,
 * date, message_id, thread_id, is_unread }) onto the exact same dedup +
 * conversation/message contract as the v1 path. v2 returns newest-first, so we
 * page until we cross the dateFrom cutoff.
 */
async function processAccountV2(
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
  const acctV2: string | null = account.unipile_account_id_v2;
  if (!accountEmail || !acctV2) return { inserted, skipped, unmatched, errors, pages };
  const cutoffMs = new Date(dateFrom).getTime();

  let cursor: string | undefined;
  let reachedCutoff = false;
  while (pages < pageLimit && !reachedCutoff) {
    let payload: any;
    try {
      payload = await unipileFetchV2(supabase, acctV2, "emails", {
        method: "GET",
        query: { limit: 50, ...(cursor ? { cursor } : {}) },
      });
    } catch (err: any) {
      logger.error(`Unipile v2 emails fetch failed for ${account.email_address}`, { error: err.message });
      const m = String(err?.message || "").match(/Unipile v2 (\d{3})/);
      const status = m ? Number(m[1]) : null;
      const is5xx = status !== null && status >= 500 && status <= 599;
      if (!is5xx) {
        await notifyError({
          taskId: "backfill-emails",
          severity: "ERROR",
          error: err,
          context: { accountId: account.id, email: account.email_address, api: "v2", status },
        });
      }
      break;
    }
    pages++;
    const items: any[] = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : (payload?.items ?? []);
    if (items.length === 0) break;

    const pageMessageIds = items.map((m) => m.message_id || m.id).filter(Boolean) as string[];
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
        const dateStr: string | null = msg.date ?? null;
        // newest-first → once we cross the window, stop paging.
        if (dateStr && new Date(dateStr).getTime() < cutoffMs) {
          reachedCutoff = true;
          continue;
        }
        const externalMessageId = msg.message_id || msg.id;
        if (!externalMessageId) {
          skipped++;
          continue;
        }
        if (existingIds.has(externalMessageId)) {
          skipped++;
          continue;
        }

        const externalConversationId = pickStr(msg.thread_id, externalMessageId) || externalMessageId;
        const subject = msg.subject ?? null;
        const fromObj = Array.isArray(msg.from) ? msg.from[0] : msg.from;
        const senderEmail = normalizeEmail(fromObj?.email ?? fromObj?.identifier ?? "");
        const senderName = pickStr(fromObj?.display_name);
        const toEmails = [
          ...(msg.to ?? []).map((r: any) => normalizeEmail(r?.email ?? r?.identifier ?? "")),
          ...(msg.cc ?? []).map((r: any) => normalizeEmail(r?.email ?? r?.identifier ?? "")),
        ].filter(Boolean) as string[];

        const isOutbound = !!senderEmail && senderEmail === accountEmail;
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

        const bodyText = stripHtml(msg.body ?? msg.snippet ?? "");
        const preview = (msg.snippet ?? bodyText ?? "").slice(0, 500);

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
              last_message_at: dateStr,
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
          sender_address: isOutbound ? accountEmail : senderEmail || null,
          recipient_address: isOutbound ? matchEmail : accountEmail,
          sent_at: dateStr,
          received_at: dateStr,
          integration_account_id: account.id,
          provider: "unipile",
          is_read: msg.is_unread === true ? false : true,
        });
        if (msgErr) {
          errors++;
          continue;
        }
        inserted++;
      } catch (err: any) {
        logger.error("v2 message processing error", { error: err.message });
        errors++;
      }
    }

    cursor = payload?.next_cursor || payload?.cursor || undefined;
    if (!cursor) break;
  }
  return { inserted, skipped, unmatched, errors, pages };
}

export const backfillEmails = inngest.createFunction(
  { id: "backfill-emails", name: "Backfill emails from Unipile (Inngest)" },
  { cron: "1-56/5 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    // Kill switch — set app_settings.BACKFILL_EMAILS_PAUSED to "true"
    // when something is wrong on the Unipile side (paused accounts,
    // billing state, etc.) and you want this cron to no-op without
    // a deploy. Cron resumes immediately on the next tick once the
    // setting is flipped back.
    const pausedSetting = (await getAppSetting("BACKFILL_EMAILS_PAUSED")).toLowerCase();
    if (pausedSetting === "true" || pausedSetting === "1" || pausedSetting === "on") {
      logger.info("backfill-emails paused via app_settings.BACKFILL_EMAILS_PAUSED");
      return { paused: true };
    }

    const daysBack = 3;
    const dateFrom = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = new Date().toISOString();
    const maxPages = 5; // hard cap per account per tick

    const emailLookup = await buildEmailLookup(supabase);
    logger.info(`Loaded ${emailLookup.size} known emails for matching`);

    const { data: accounts, error: acctErr } = await supabase
      .from("integration_accounts")
      .select("id, email_address, owner_user_id, unipile_account_id, unipile_account_id_v2, unipile_provider")
      .eq("account_type", "email")
      .eq("is_active", true)
      .or("unipile_account_id.not.is.null,unipile_account_id_v2.not.is.null");

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
        // Route to v2 when the mailbox has a canonical acc_xxx (the OUTLOOK
        // boxes live on the v2 Unipile app now; the v1 workspace is empty).
        const result = account.unipile_account_id_v2
          ? await processAccountV2(supabase, account, emailLookup, dateFrom, dateTo, maxPages, logger)
          : await processAccount(supabase, account, emailLookup, dateFrom, dateTo, maxPages, logger);
        results.push({ email: account.email_address, ...result });
        logger.info(`Processed ${account.email_address}`, result);
      } catch (err: any) {
        logger.error("Account processing error", { email: account.email_address, error: err.message });
        results.push({ email: account.email_address, error: err.message });
        // No notifyError here — the inner page-fetch catch already alerts
        // on non-5xx Unipile errors at ERROR severity, and downstream
        // failures (DB insert, cursor advance) are noisy on Unipile-side
        // 5xx incidents without being independently actionable. The
        // logger.error above keeps the row in Inngest run history.
      }
    }

    const totalInserted = results.reduce((s, r: any) => s + (r.inserted ?? 0), 0);
    const totalUnmatched = results.reduce((s, r: any) => s + (r.unmatched ?? 0), 0);
    logger.info("Email backfill complete", { totalInserted, totalUnmatched, accounts: results.length });

    return { dateFrom, dateTo, knownEmails: emailLookup.size, results, totalInserted, totalUnmatched };
  },
);
