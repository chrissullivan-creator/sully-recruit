import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID")!;
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET")!;
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";
const MICROSOFT_GRAPH_ACCOUNT_EMAILS = Deno.env.get("MICROSOFT_GRAPH_ACCOUNT_EMAILS") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}

function normalizeEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const v = e.trim().toLowerCase();
  return v || null;
}

async function refreshToken(account: any): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: MICROSOFT_GRAPH_CLIENT_ID, client_secret: MICROSOFT_GRAPH_CLIENT_SECRET,
        grant_type: "refresh_token", refresh_token: account.refresh_token,
        scope: "offline_access Mail.Read Mail.Send User.Read openid profile" }) }
  );
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Token refresh: ${data?.error_description}`);
  await supabase.from("integration_accounts").update({
    access_token: data.access_token, refresh_token: data.refresh_token ?? account.refresh_token,
    token_expires_at: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  return data.access_token;
}

async function getToken(account: any): Promise<string> {
  if (account.access_token && account.token_expires_at && new Date(account.token_expires_at).getTime() - Date.now() > 300000)
    return account.access_token;
  return refreshToken(account);
}

async function buildEmailLookup(): Promise<Map<string, { type: 'candidate' | 'contact'; id: string; owner_user_id: string | null }>> {
  const map = new Map();
  const { data: candidates } = await supabase.from("candidates").select("id, email, owner_user_id").not("email", "is", null).neq("email", "");
  for (const c of candidates ?? []) { const e = normalizeEmail(c.email); if (e) map.set(e, { type: "candidate", id: c.id, owner_user_id: c.owner_user_id }); }
  const { data: contacts } = await supabase.from("contacts").select("id, email, owner_user_id").not("email", "is", null).neq("email", "");
  for (const c of contacts ?? []) { const e = normalizeEmail(c.email); if (e) map.set(e, { type: "contact", id: c.id, owner_user_id: c.owner_user_id }); }
  return map;
}

async function processAccount(
  account: any, emailLookup: Map<string, any>,
  dateFrom: string, dateTo: string,
  maxPages: number
): Promise<{ inserted: number; skipped: number; errors: number; hit_limit: boolean }> {
  let inserted = 0, skipped = 0, errors = 0, hit_limit = false;
  const token = await getToken(account);
  const accountEmail = normalizeEmail(account.email_address);
  const folders = ["Inbox", "SentItems"];

  for (const folder of folders) {
    const select = "id,conversationId,subject,body,bodyPreview,from,toRecipients,sentDateTime,receivedDateTime";
    let url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages` +
      `?$select=${select}&$filter=receivedDateTime ge ${dateFrom} and receivedDateTime le ${dateTo}` +
      `&$top=50&$orderby=receivedDateTime desc`;
    let pageCount = 0;

    while (url && pageCount < maxPages) {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) { console.error(`[backfill] ${folder} page ${pageCount} failed: ${resp.status}`); break; }
      const data = await resp.json();
      const messages = data.value ?? [];
      pageCount++;
      if (pageCount >= maxPages && data["@odata.nextLink"]) hit_limit = true;

      for (const msg of messages) {
        try {
          const externalMessageId = msg.id as string;
          const externalConversationId = msg.conversationId as string;
          const subject = msg.subject ?? null;
          const senderEmail = normalizeEmail(msg.from?.emailAddress?.address);
          const senderName = msg.from?.emailAddress?.name ?? null;
          const sentAt = msg.sentDateTime ?? null;
          const receivedAt = msg.receivedDateTime ?? null;
          const bodyText = stripHtml(msg.body?.content ?? msg.bodyPreview ?? "");
          const preview = (msg.bodyPreview ?? bodyText ?? "").slice(0, 500);
          const toEmails = (msg.toRecipients ?? []).map((r: any) => normalizeEmail(r?.emailAddress?.address)).filter(Boolean);
          const isOutbound = folder === "SentItems" || normalizeEmail(senderEmail) === accountEmail;
          const matchEmail = isOutbound ? toEmails[0] : senderEmail;
          if (!matchEmail) { skipped++; continue; }
          const entity = emailLookup.get(matchEmail);
          if (!entity) { skipped++; continue; }

          const { data: existing } = await supabase.from("messages").select("id").eq("external_message_id", externalMessageId).maybeSingle();
          if (existing) { skipped++; continue; }

          const candidateId = entity.type === "candidate" ? entity.id : null;
          const contactId = entity.type === "contact" ? entity.id : null;

          let { data: conversation } = await supabase.from("conversations").select("id")
            .eq("external_conversation_id", externalConversationId).eq("integration_account_id", account.id).maybeSingle();

          if (!conversation) {
            const { data: created } = await supabase.from("conversations").insert({
              candidate_id: candidateId, contact_id: contactId, channel: "email",
              integration_account_id: account.id, external_conversation_id: externalConversationId,
              subject, last_message_preview: preview, last_message_at: receivedAt ?? sentAt,
              is_read: true, is_archived: false,
              assigned_user_id: entity.owner_user_id ?? account.owner_user_id,
            }).select("id").single();
            conversation = created;
          }

          if (!conversation) { errors++; continue; }

          const { error: msgErr } = await supabase.from("messages").insert({
            conversation_id: conversation.id, candidate_id: candidateId, contact_id: contactId,
            channel: "email", direction: isOutbound ? "outbound" : "inbound", message_type: "email",
            external_message_id: externalMessageId, external_conversation_id: externalConversationId,
            subject, body: bodyText, sender_name: senderName,
            sender_address: isOutbound ? accountEmail : senderEmail,
            recipient_address: isOutbound ? matchEmail : accountEmail,
            sent_at: sentAt, received_at: receivedAt, integration_account_id: account.id,
            provider: "microsoft", is_read: true,
          });

          if (msgErr) { errors++; continue; }
          inserted++;
        } catch (err) { console.error("[backfill] msg error:", err); errors++; }
      }
      url = data["@odata.nextLink"] ?? "";
    }
  }
  return { inserted, skipped, errors, hit_limit };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  // Support explicit date range OR days_back
  const dateFrom: string = body.date_from ?? new Date(Date.now() - Number(body.days_back ?? 90) * 24 * 60 * 60 * 1000).toISOString();
  const dateTo: string = body.date_to ?? new Date().toISOString();
  const maxPages: number = Number(body.max_pages ?? 10); // 10 pages = 500 emails per folder per account

  console.log(`[backfill-emails] ${dateFrom} → ${dateTo} max_pages=${maxPages}`);

  const emailLookup = await buildEmailLookup();
  console.log(`[backfill-emails] ${emailLookup.size} known emails`);

  const graphEmails = new Set(MICROSOFT_GRAPH_ACCOUNT_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  const { data: accounts } = await supabase.from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at, owner_user_id")
    .eq("is_active", true).not("refresh_token", "is", null);

  const emailAccounts = (accounts ?? []).filter((a: any) => graphEmails.has((a.email_address ?? "").toLowerCase().trim()));
  if (!emailAccounts.length) return json({ error: "No graph accounts found" }, 400);

  const results = [];
  for (const account of emailAccounts) {
    const result = await processAccount(account, emailLookup, dateFrom, dateTo, maxPages);
    results.push({ email: account.email_address, ...result });
    console.log(`[backfill] ${account.email_address}: inserted=${result.inserted} skipped=${result.skipped} hit_limit=${result.hit_limit}`);
  }

  return json({ ok: true, date_from: dateFrom, date_to: dateTo, known_emails: emailLookup.size, results, total_inserted: results.reduce((s, r) => s + r.inserted, 0) });
});
