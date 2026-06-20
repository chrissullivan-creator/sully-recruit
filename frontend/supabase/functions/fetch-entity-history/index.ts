import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID") ?? "";
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET") ?? "";
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") ?? "common";
const MICROSOFT_GRAPH_ACCOUNT_EMAILS = Deno.env.get("MICROSOFT_GRAPH_ACCOUNT_EMAILS") ?? "";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") ?? Deno.env.get("unipile_api_key") ?? "";
const UNIPILE_BASE_URL = "https://api2.unipile.com:13150";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function normEmail(e: string | null | undefined): string | null {
  return e ? e.trim().toLowerCase() : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function normLinkedIn(u: string | null | undefined): string | null {
  const m = (u ?? "").match(/linkedin\.com\/in\/([^/?\s#]+)/);
  return m ? m[1].toLowerCase().replace(/\/+$/, "") : null;
}

async function refreshGraphToken(account: any, supabase: any): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MICROSOFT_GRAPH_CLIENT_ID,
        client_secret: MICROSOFT_GRAPH_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: account.refresh_token,
        scope: "offline_access Mail.Read Mail.Send User.Read",
      }),
    }
  );
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
  const data = await resp.json();
  await supabase.from("integration_accounts").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? account.refresh_token,
    token_expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
  }).eq("id", account.id);
  return data.access_token;
}

async function getGraphToken(account: any, supabase: any): Promise<string> {
  if (account.access_token && account.token_expires_at &&
    new Date(account.token_expires_at).getTime() - Date.now() > 300000)
    return account.access_token;
  return refreshGraphToken(account, supabase);
}

// Search Outlook for emails to/from a specific email address
async function fetchEmailHistory(
  supabase: any,
  entityEmail: string,
  candidateId: string | null,
  contactId: string | null,
  lookbackDays = 730 // 2 years
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0, skipped = 0;

  const graphEmails = new Set(MICROSOFT_GRAPH_ACCOUNT_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at, owner_user_id")
    .eq("is_active", true)
    .not("refresh_token", "is", null);

  const emailAccounts = (accounts ?? []).filter((a: any) =>
    graphEmails.has((a.email_address ?? "").toLowerCase().trim())
  );

  const dateFrom = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  for (const account of emailAccounts) {
    const token = await getGraphToken(account, supabase);
    const accountEmail = normEmail(account.email_address);

    // Search both Inbox and Sent for this specific email address
    const folders = [
      { name: "Inbox", filter: `from/emailAddress/address eq '${entityEmail}'` },
      { name: "SentItems", filter: `toRecipients/any(r:r/emailAddress/address eq '${entityEmail}')` },
    ];

    for (const folder of folders) {
      const isOutbound = folder.name === "SentItems";
      const select = "id,conversationId,subject,bodyPreview,body,from,toRecipients,sentDateTime,receivedDateTime";
      let url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder.name}/messages` +
        `?$filter=${encodeURIComponent(folder.filter + ` and receivedDateTime ge ${dateFrom}`)}` +
        `&$select=${select}&$top=100&$orderby=receivedDateTime desc`;

      let pages = 0;
      while (url && pages < 5) {
        pages++;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) break;
        const data = await resp.json();

        for (const msg of data.value ?? []) {
          const externalId = msg.id as string;
          const { data: existing } = await supabase.from("messages")
            .select("id").eq("external_message_id", externalId).maybeSingle();
          if (existing) { skipped++; continue; }

          const subject = msg.subject ?? null;
          const senderEmail = normEmail(msg.from?.emailAddress?.address);
          const bodyText = stripHtml(msg.body?.content ?? msg.bodyPreview ?? "");
          const preview = (msg.bodyPreview ?? "").slice(0, 500);
          const sentAt = msg.sentDateTime ?? null;
          const receivedAt = msg.receivedDateTime ?? null;
          const externalConvId = msg.conversationId as string;

          // Get or create conversation
          let { data: conv } = await supabase.from("conversations").select("id")
            .eq("external_conversation_id", externalConvId)
            .eq("integration_account_id", account.id).maybeSingle();

          if (!conv) {
            const { data: created } = await supabase.from("conversations").insert({
              candidate_id: candidateId, contact_id: contactId, channel: "email",
              integration_account_id: account.id,
              external_conversation_id: externalConvId,
              subject, last_message_preview: preview,
              last_message_at: receivedAt ?? sentAt,
              is_read: true, is_archived: false,
              assigned_user_id: account.owner_user_id,
            }).select("id").single();
            conv = created;
          }

          if (!conv) continue;

          const toEmails = (msg.toRecipients ?? []).map((r: any) => normEmail(r?.emailAddress?.address)).filter(Boolean);

          await supabase.from("messages").insert({
            conversation_id: conv.id,
            candidate_id: candidateId,
            contact_id: contactId,
            channel: "email",
            direction: isOutbound ? "outbound" : "inbound",
            external_message_id: externalId,
            external_conversation_id: externalConvId,
            subject, body: bodyText,
            sender_address: isOutbound ? accountEmail : senderEmail,
            recipient_address: isOutbound ? entityEmail : accountEmail,
            sent_at: sentAt, received_at: receivedAt,
            integration_account_id: account.id,
            provider: "microsoft", is_read: true,
          });
          inserted++;
        }

        url = data["@odata.nextLink"] ?? "";
      }
    }
  }

  return { inserted, skipped };
}

// Search stored LinkedIn messages for a person by their LinkedIn URL slug
async function fetchLinkedInHistory(
  supabase: any,
  linkedinSlug: string | null,
  candidateId: string | null,
  contactId: string | null
): Promise<{ inserted: number; skipped: number }> {
  if (!linkedinSlug) return { inserted: 0, skipped: 0 };

  // Check if we already have LinkedIn messages for this entity
  const { count } = await supabase.from("messages")
    .select("id", { count: "exact", head: true })
    .eq(candidateId ? "candidate_id" : "contact_id", candidateId ?? contactId)
    .like("channel", "linkedin%");

  if ((count ?? 0) > 0) return { inserted: 0, skipped: count ?? 0 };

  // Look for existing messages in DB that mention this linkedin slug (unlinked messages)
  const { data: unlinked } = await supabase.from("messages")
    .select("id, sender_address, recipient_address")
    .like("channel", "linkedin%")
    .is(candidateId ? "candidate_id" : "contact_id", null)
    .or(`sender_address.ilike.%${linkedinSlug}%,recipient_address.ilike.%${linkedinSlug}%`)
    .limit(200);

  if (!unlinked?.length) return { inserted: 0, skipped: 0 };

  // Link them
  const ids = unlinked.map((m: any) => m.id);
  const update = candidateId ? { candidate_id: candidateId } : { contact_id: contactId };
  await supabase.from("messages").update(update).in("id", ids);

  // Also link conversations
  const { data: convs } = await supabase.from("conversations")
    .select("id")
    .like("channel", "linkedin%")
    .is(candidateId ? "candidate_id" : "contact_id", null)
    .or(`subject.ilike.%${linkedinSlug}%,last_message_preview.ilike.%${linkedinSlug}%`)
    .limit(50);

  if (convs?.length) {
    await supabase.from("conversations").update(update).in("id", convs.map((c: any) => c.id));
  }

  return { inserted: ids.length, skipped: 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });

  try {
    const body = await req.json();
    const { candidate_id, contact_id } = body;
    if (!candidate_id && !contact_id) return respond({ error: "candidate_id or contact_id required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch the entity
    let email: string | null = null;
    let linkedinUrl: string | null = null;
    let entityName: string | null = null;

    if (candidate_id) {
      const { data } = await supabase.from("candidates")
        .select("full_name, email, linkedin_url").eq("id", candidate_id).maybeSingle();
      email = normEmail(data?.email);
      linkedinUrl = data?.linkedin_url ?? null;
      entityName = data?.full_name ?? candidate_id;
    } else {
      const { data } = await supabase.from("contacts")
        .select("full_name, email, linkedin_url").eq("id", contact_id).maybeSingle();
      email = normEmail(data?.email);
      linkedinUrl = data?.linkedin_url ?? null;
      entityName = data?.full_name ?? contact_id;
    }

    const linkedinSlug = normLinkedIn(linkedinUrl);
    console.log(`[fetch-entity-history] ${entityName} | email=${email} | linkedin=${linkedinSlug}`);

    const results: any = { entity: entityName, email_history: null, linkedin_history: null };

    // Fetch email history
    if (email) {
      results.email_history = await fetchEmailHistory(
        supabase, email, candidate_id ?? null, contact_id ?? null
      );
      console.log(`[fetch-entity-history] email: inserted=${results.email_history.inserted} skipped=${results.email_history.skipped}`);
    }

    // Fetch LinkedIn history
    results.linkedin_history = await fetchLinkedInHistory(
      supabase, linkedinSlug, candidate_id ?? null, contact_id ?? null
    );
    console.log(`[fetch-entity-history] linkedin: inserted=${results.linkedin_history.inserted} skipped=${results.linkedin_history.skipped}`);

    return respond({ success: true, ...results });

  } catch (err: any) {
    console.error("[fetch-entity-history] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
