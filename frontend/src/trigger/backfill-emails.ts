import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting, getMicrosoftGraphCredentials } from "./lib/supabase";
import { normalizeEmail, delay } from "./lib/resume-parsing";
import { isMarketingEmail } from "./purge-marketing-emails";

// Backfill emails from Microsoft Graph (Inbox + SentItems).
//
// CRITICAL FIX: syncs ALL emails, not just those matching known
// candidates/contacts. Unmatched emails get candidate_id and contact_id
// set to null so they still appear in the Inbox UI.
//
// Schedule: every 5 minutes (1-56/5 * * * *)

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

async function refreshToken(supabase: any, account: any, tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: account.refresh_token,
        scope: "offline_access Mail.Read Mail.Send User.Read openid profile",
      }),
    },
  );
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Token refresh: ${data?.error_description}`);

  await supabase
    .from("integration_accounts")
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? account.refresh_token,
      token_expires_at: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", account.id);

  return data.access_token;
}

async function getToken(supabase: any, account: any, tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  if (
    account.access_token &&
    account.token_expires_at &&
    new Date(account.token_expires_at).getTime() - Date.now() > 300_000
  ) {
    return account.access_token;
  }
  return refreshToken(supabase, account, tenantId, clientId, clientSecret);
}

async function buildEmailLookup(
  supabase: any,
): Promise<Map<string, { type: "candidate" | "contact"; id: string; owner_user_id: string | null }>> {
  const map = new Map<string, { type: "candidate" | "contact"; id: string; owner_user_id: string | null }>();

  // Supabase's default range is 1000 rows. With ~6k people in the firm,
  // an unpaginated query silently dropped everyone past the first page —
  // any inbound email from a "page 2+" person landed unmatched.
  // Paginate explicitly until we hit a partial page.
  const PAGE = 1000;
  const loadAll = async (table: "people" | "contacts", as: "candidate" | "contact") => {
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from(table)
        .select("id, email, owner_user_id, type")
        .not("email", "is", null)
        .neq("email", "")
        .range(from, from + PAGE - 1);
      const rows = data ?? [];
      for (const c of rows) {
        // For the unified `people` table, route by row.type — clients
        // become contact entries, anything else stays candidate. The
        // contacts view already filters, so `as` wins there.
        const resolvedType: "candidate" | "contact" =
          table === "contacts" ? "contact"
            : (c as any).type === "client" ? "contact" : "candidate";
        const e = normalizeEmail(c.email);
        if (e) map.set(e, { type: resolvedType, id: c.id, owner_user_id: c.owner_user_id });
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  };

  await loadAll("people", "candidate");
  await loadAll("contacts", "contact");

  return map;
}

async function processAccount(
  supabase: any,
  account: any,
  emailLookup: Map<string, any>,
  dateFrom: string,
  dateTo: string,
  maxPages: number,
  token: string,
): Promise<{ inserted: number; skipped: number; unmatched: number; errors: number; hit_limit: boolean }> {
  let inserted = 0,
    skipped = 0,
    unmatched = 0,
    errors = 0,
    hit_limit = false;
  const accountEmail = normalizeEmail(account.email_address);
  const folders = ["Inbox", "SentItems"];

  for (const folder of folders) {
    const select =
      "id,conversationId,subject,body,bodyPreview,from,toRecipients,sentDateTime,receivedDateTime";
    let url =
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages` +
      `?$select=${select}&$filter=receivedDateTime ge ${dateFrom} and receivedDateTime le ${dateTo}` +
      `&$top=50&$orderby=receivedDateTime desc`;
    let pageCount = 0;

    while (url && pageCount < maxPages) {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        logger.error(`${folder} page ${pageCount} failed`, { status: resp.status });
        break;
      }
      const data = await resp.json();
      const messages = data.value ?? [];
      pageCount++;
      if (pageCount >= maxPages && data["@odata.nextLink"]) hit_limit = true;

      // Batch dedup: load all known external_message_ids for this page in one query
      const pageMessageIds = messages.map((m: any) => m.id).filter(Boolean);
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

      for (const msg of messages) {
        try {
          const externalMessageId = msg.id as string;
          if (existingIds.has(externalMessageId)) {
            skipped++;
            continue;
          }

          const externalConversationId = msg.conversationId as string;
          const subject = msg.subject ?? null;
          const senderEmail = normalizeEmail(msg.from?.emailAddress?.address);
          const senderName = msg.from?.emailAddress?.name ?? null;
          const sentAt = msg.sentDateTime ?? null;
          const receivedAt = msg.receivedDateTime ?? null;
          const bodyText = stripHtml(msg.body?.content ?? msg.bodyPreview ?? "");
          const preview = (msg.bodyPreview ?? bodyText ?? "").slice(0, 500);
          const toEmails = (msg.toRecipients ?? [])
            .map((r: any) => normalizeEmail(r?.emailAddress?.address))
            .filter(Boolean);
          const isOutbound = folder === "SentItems" || normalizeEmail(senderEmail) === accountEmail;
          const matchEmail = isOutbound ? toEmails[0] : senderEmail;

          if (!matchEmail) {
            skipped++;
            continue;
          }

          // Channel routing rule: Outlook ingestion ALWAYS produces channel='email'.
          // Unipile is the only source that creates channel='linkedin' / 'linkedin_recruiter'.
          // We still drop pure LinkedIn marketing/notification noise from messages-noreply@.
          if (!isOutbound && senderEmail === "messages-noreply@linkedin.com") {
            skipped++;
            continue;
          }

          // Skip marketing/newsletter emails
          if (isMarketingEmail(isOutbound ? null : senderEmail)) {
            skipped++;
            continue;
          }

          // CRITICAL FIX: Match to entity but do NOT skip if no match found
          const entity = emailLookup.get(matchEmail);
          const candidateId = entity?.type === "candidate" ? entity.id : null;
          const contactId = entity?.type === "contact" ? entity.id : null;

          if (!entity) unmatched++;

          // Upsert conversation
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

          // Insert message
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
            sender_address: isOutbound ? accountEmail : senderEmail,
            recipient_address: isOutbound ? matchEmail : accountEmail,
            sent_at: sentAt,
            received_at: receivedAt,
            integration_account_id: account.id,
            provider: "microsoft",
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
      url = data["@odata.nextLink"] ?? "";
    }
  }
  return { inserted, skipped, unmatched, errors, hit_limit };
}

export const backfillEmails = schedules.task({
  id: "backfill-emails",
  maxDuration: 300,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

    // Look back 3 days by default since this runs every 5 min.
    // 3 days gives enough buffer to survive brief outages or missed runs
    // without creating excessive API calls on each run.
    // Dedup by external_message_id prevents double-inserts.
    const daysBack = 3;
    const dateFrom = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = new Date().toISOString();
    const maxPages = 3; // 3 pages × 50 = 150 emails per folder per account

    logger.info("Starting email backfill", { dateFrom, dateTo });

    const emailLookup = await buildEmailLookup(supabase);
    logger.info(`Loaded ${emailLookup.size} known emails for matching`);

    // Get configured Graph account emails
    const graphEmailsSetting = await getAppSetting("MICROSOFT_GRAPH_ACCOUNT_EMAILS");
    const graphEmails = new Set(
      graphEmailsSetting
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, email_address, access_token, refresh_token, token_expires_at, owner_user_id")
      .eq("is_active", true)
      .not("refresh_token", "is", null);

    const emailAccounts = (accounts ?? []).filter((a: any) =>
      graphEmails.has((a.email_address ?? "").toLowerCase().trim()),
    );

    if (!emailAccounts.length) {
      logger.warn("No Graph accounts found");
      return { error: "No graph accounts found", results: [] };
    }

    const results = [];
    for (const account of emailAccounts) {
      try {
        const token = await getToken(supabase, account, tenantId, clientId, clientSecret);
        const result = await processAccount(supabase, account, emailLookup, dateFrom, dateTo, maxPages, token);
        results.push({ email: account.email_address, ...result });
        logger.info(`Processed ${account.email_address}`, result);
      } catch (err: any) {
        logger.error("Account processing error", { email: account.email_address, error: err.message });
        results.push({ email: account.email_address, error: err.message });
      }
    }

    const totalInserted = results.reduce((s, r: any) => s + (r.inserted ?? 0), 0);
    const totalUnmatched = results.reduce((s, r: any) => s + (r.unmatched ?? 0), 0);
    logger.info("Email backfill complete", { totalInserted, totalUnmatched, accounts: results.length });

    return { dateFrom, dateTo, knownEmails: emailLookup.size, results, totalInserted, totalUnmatched };
  },
});
