import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") || "https://api19.unipile.com:14926";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
const uniHeaders = { "X-API-KEY": UNIPILE_API_KEY, "Accept": "application/json" };

function normalizeLinkedIn(u: string | null | undefined): string | null {
  if (!u) return null;
  const m = String(u).match(/linkedin\.com\/in\/([^/?\s]+)/);
  return m ? m[1].toLowerCase().replace(/\/$/, "") : null;
}

async function findEntity(unipileId: string | null, linkedinUrl: string | null): Promise<{ type: string; id: string; owner_user_id: string | null } | null> {
  // Check candidates
  if (unipileId) {
    const { data } = await supabase.from("candidates").select("id, owner_user_id").eq("unipile_id", unipileId).maybeSingle();
    if (data) return { type: "candidate", ...data };
  }
  if (linkedinUrl) {
    const slug = normalizeLinkedIn(linkedinUrl);
    if (slug) {
      const { data } = await supabase.from("candidates").select("id, owner_user_id").ilike("linkedin_url", `%${slug}%`).maybeSingle();
      if (data) return { type: "candidate", ...data };
    }
  }
  // Check contacts
  if (unipileId) {
    const { data } = await supabase.from("contacts").select("id, owner_user_id").eq("unipile_id", unipileId).maybeSingle();
    if (data) return { type: "contact", ...data };
  }
  if (linkedinUrl) {
    const slug = normalizeLinkedIn(linkedinUrl);
    if (slug) {
      const { data } = await supabase.from("contacts").select("id, owner_user_id").ilike("linkedin_url", `%${slug}%`).maybeSingle();
      if (data) return { type: "contact", ...data };
    }
  }
  return null;
}

async function upsertConversation(chatId: string, entity: { type: string; id: string; owner_user_id: string | null } | null, channel: string, integrationAccountId: string): Promise<string> {
  // Check if conversation already exists for this chat
  const { data: existing } = await supabase.from("conversations").select("id")
    .eq("external_conversation_id", chatId).eq("integration_account_id", integrationAccountId).maybeSingle();
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const { data: created, error } = await supabase.from("conversations").insert({
    candidate_id: entity?.type === "candidate" ? entity.id : null,
    contact_id: entity?.type === "contact" ? entity.id : null,
    channel,
    integration_account_id: integrationAccountId,
    external_conversation_id: chatId,
    is_read: true,
    is_archived: false,
    assigned_user_id: entity?.owner_user_id ?? null,
    last_message_at: now,
    created_at: now,
    updated_at: now,
  }).select("id").single();

  if (error || !created) throw new Error(`Conversation upsert failed: ${error?.message}`);
  return created.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const accountEmail: string = body.account_email ?? "chris.sullivan@emeraldrecruit.com";
  const maxChats: number = Number(body.max_chats ?? 50);
  const cursor: string | null = body.cursor ?? null; // for pagination

  const { data: account } = await supabase.from("integration_accounts")
    .select("id, email_address, unipile_account_id, owner_user_id")
    .eq("email_address", accountEmail).eq("is_active", true)
    .not("unipile_account_id", "is", null).maybeSingle();

  if (!account?.unipile_account_id) return json({ error: `No Unipile account for ${accountEmail}` }, 400);

  const stats = { chats_scanned: 0, messages_scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  let nextCursor: string | null = null;

  // Fetch chats from Unipile
  let chatsUrl = `${UNIPILE_API_URL}/api/v1/chats?account_id=${account.unipile_account_id}&limit=${maxChats}`;
  if (cursor) chatsUrl += `&cursor=${cursor}`;

  const chatsResp = await fetch(chatsUrl, { headers: uniHeaders });
  if (!chatsResp.ok) {
    const err = await chatsResp.text();
    return json({ error: `Unipile chats ${chatsResp.status}: ${err.slice(0, 200)}` }, 500);
  }
  const chatsData = await chatsResp.json();
  const chats = chatsData.items ?? chatsData.chats ?? chatsData.data ?? [];
  nextCursor = chatsData.cursor ?? chatsData.next_cursor ?? null;

  console.log(`[backfill-linkedin] account=${accountEmail} chats=${chats.length} cursor=${cursor}`);

  for (const chat of chats) {
    stats.chats_scanned++;
    const chatId = chat.id as string;
    if (!chatId) continue;

    try {
      // Determine channel from chat provider
      const providerType = String(chat.provider_type ?? chat.type ?? "").toLowerCase();
      const channel = providerType.includes("sales") ? "linkedin_sales_nav"
        : providerType.includes("recruiter") ? "linkedin_recruiter"
        : "linkedin";

      // Find the OTHER attendee (not us)
      const attendees: any[] = chat.attendees ?? chat.members ?? [];
      const otherAttendee = attendees.find((a: any) => a.id !== account.unipile_account_id && !String(a.id ?? "").includes(account.unipile_account_id));
      const otherUnipileId = otherAttendee?.provider_id ?? otherAttendee?.id ?? null;
      const otherUrl = otherAttendee?.url ?? otherAttendee?.profile_url ?? null;

      // Match to candidate or contact
      const entity = await findEntity(otherUnipileId, otherUrl);

      // Stamp unipile_id if we found a match and they don't have one yet
      if (entity && otherUnipileId) {
        const table = entity.type === "candidate" ? "candidates" : "contacts";
        const { data: current } = await supabase.from(table).select("unipile_id").eq("id", entity.id).maybeSingle();
        if (!current?.unipile_id) {
          await supabase.from(table).update({ unipile_id: otherUnipileId, updated_at: new Date().toISOString() }).eq("id", entity.id);
        }
      }

      // Upsert conversation
      const conversationId = await upsertConversation(chatId, entity, channel, account.id);

      // Fetch messages for this chat
      const msgsResp = await fetch(
        `${UNIPILE_API_URL}/api/v1/chats/${chatId}/messages?account_id=${account.unipile_account_id}&limit=100`,
        { headers: uniHeaders }
      );
      if (!msgsResp.ok) { stats.errors++; continue; }
      const msgsData = await msgsResp.json();
      const messages = msgsData.items ?? msgsData.messages ?? msgsData.data ?? [];

      for (const msg of messages) {
        stats.messages_scanned++;
        const msgId = msg.id as string;
        if (!msgId) continue;

        // Dedup
        const { data: existing } = await supabase.from("messages").select("id").eq("unipile_message_id", msgId).maybeSingle();
        if (existing) { stats.skipped++; continue; }

        const isSender = msg.is_sender === true || msg.sender_id === account.unipile_account_id;
        const direction = isSender ? "outbound" : "inbound";
        const sentAt = msg.timestamp ?? msg.sent_at ?? msg.created_at ?? new Date().toISOString();
        const body = msg.text ?? msg.body ?? msg.content ?? "";
        const senderAddress = isSender ? accountEmail : (otherUrl ?? otherUnipileId ?? null);

        const { error: insertErr } = await supabase.from("messages").insert({
          conversation_id: conversationId,
          candidate_id: entity?.type === "candidate" ? entity.id : null,
          contact_id: entity?.type === "contact" ? entity.id : null,
          integration_account_id: account.id,
          channel,
          direction,
          body,
          unipile_message_id: msgId,
          unipile_chat_id: chatId,
          sender_address: senderAddress,
          sent_at: new Date(sentAt).toISOString(),
          is_read: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          inserted_at: new Date().toISOString(),
        });

        if (insertErr) { console.error(`[backfill-linkedin] msg insert error:`, insertErr.message); stats.errors++; }
        else stats.inserted++;
      }

      // Update conversation with latest message info
      if (messages.length > 0) {
        const latest = messages[0];
        await supabase.from("conversations").update({
          last_message_preview: (latest.text ?? latest.body ?? "").slice(0, 500),
          last_message_at: new Date(latest.timestamp ?? latest.sent_at ?? Date.now()).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", conversationId);
      }

    } catch (err) {
      console.error(`[backfill-linkedin] chat ${chatId} error:`, err);
      stats.errors++;
    }
  }

  console.log(`[backfill-linkedin] done:`, stats);
  return json({ ok: true, account: accountEmail, stats, next_cursor: nextCursor, has_more: !!nextCursor });
});
