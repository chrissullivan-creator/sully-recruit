import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { normalizeLinkedIn } from "./lib/resume-parsing";
import { unipileFetch, canonicalChannel } from "./lib/unipile-v2";

// Backfill LinkedIn messages from Unipile for a specific account.
//
// Schedules (create in Trigger.dev Dashboard):
//   Chris: every 5 min   externalId=backfill-linkedin-chris
//   Nancy: every 5 min   externalId=backfill-linkedin-nancy
//   Ashley: every 5 min  externalId=backfill-linkedin-ashley
//
// Each schedule sets payload: { account_email, max_chats }

async function findEntity(
  supabase: any,
  unipileId: string | null,
  linkedinUrl: string | null,
): Promise<{ type: string; id: string; owner_user_id: string | null } | null> {
  // Match by any Unipile ID column (recruiter, classic, or provider_id)
  if (unipileId) {
    const { data } = await supabase
      .from("people")
      .select("id, owner_user_id")
      .or(
        `unipile_recruiter_id.eq.${unipileId},unipile_classic_id.eq.${unipileId},unipile_provider_id.eq.${unipileId}`,
      )
      .maybeSingle();
    if (data) return { type: "candidate", ...data };
  }
  if (linkedinUrl) {
    const slug = normalizeLinkedIn(linkedinUrl);
    if (slug) {
      const { data } = await supabase
        .from("people")
        .select("id, owner_user_id")
        .ilike("linkedin_url", `%${slug}%`)
        .maybeSingle();
      if (data) return { type: "candidate", ...data };
    }
  }
  if (unipileId) {
    const { data } = await supabase
      .from("contacts")
      .select("id, owner_user_id")
      .or(
        `unipile_recruiter_id.eq.${unipileId},unipile_classic_id.eq.${unipileId},unipile_provider_id.eq.${unipileId}`,
      )
      .maybeSingle();
    if (data) return { type: "contact", ...data };
  }
  if (linkedinUrl) {
    const slug = normalizeLinkedIn(linkedinUrl);
    if (slug) {
      const { data } = await supabase
        .from("contacts")
        .select("id, owner_user_id")
        .ilike("linkedin_url", `%${slug}%`)
        .maybeSingle();
      if (data) return { type: "contact", ...data };
    }
  }
  return null;
}

async function upsertConversation(
  supabase: any,
  chatId: string,
  entity: { type: string; id: string; owner_user_id: string | null } | null,
  channel: string,
  integrationAccountId: string,
  contentType: string | null,
): Promise<string> {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("external_conversation_id", chatId)
    .eq("integration_account_id", integrationAccountId)
    .maybeSingle();
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const { data: created, error } = await supabase
    .from("conversations")
    .insert({
      candidate_id: entity?.type === "candidate" ? entity.id : null,
      contact_id: entity?.type === "contact" ? entity.id : null,
      channel,
      content_type: contentType,
      integration_account_id: integrationAccountId,
      external_conversation_id: chatId,
      is_read: true,
      is_archived: false,
      assigned_user_id: entity?.owner_user_id ?? null,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (error || !created) throw new Error(`Conversation upsert failed: ${error?.message}`);
  return created.id;
}

// Map externalId to account config
const LINKEDIN_ACCOUNTS: Record<string, { email: string; maxChats: number }> = {
  "backfill-linkedin-chris": { email: "chris.sullivan@emeraldrecruit.com", maxChats: 50 },
  "backfill-linkedin-nancy": { email: "nancy.eberlein@emeraldrecruit.com", maxChats: 50 },
  "backfill-linkedin-ashley": { email: "ashley.leichner@emeraldrecruit.com", maxChats: 50 },
};

export const backfillLinkedinMessages = schedules.task({
  id: "backfill-linkedin-messages",
  maxDuration: 300,
  run: async (payload) => {
    const config = LINKEDIN_ACCOUNTS[payload.externalId ?? ""] ?? LINKEDIN_ACCOUNTS["backfill-linkedin-chris"];
    const accountEmail = config.email;
    const maxChats = 20; // Keep small since this runs every 5 min

    const supabase = getSupabaseAdmin();

    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, email_address, unipile_account_id, owner_user_id, account_type")
      .eq("email_address", accountEmail)
      .eq("is_active", true)
      .not("unipile_account_id", "is", null)
      .maybeSingle();

    if (!account?.unipile_account_id) {
      logger.warn(`No Unipile account for ${accountEmail}`);
      return { error: `No Unipile account for ${accountEmail}` };
    }

    const stats = { chats_scanned: 0, messages_scanned: 0, inserted: 0, skipped: 0, errors: 0 };

    // v2 path: GET /api/v2/{account_id}/chats
    const chatsData: any = await unipileFetch(
      supabase,
      account.unipile_account_id,
      `chats`,
      { method: "GET", query: { limit: maxChats } },
    );
    const chats = chatsData.items ?? chatsData.chats ?? chatsData.data ?? [];

    logger.info(`Fetched ${chats.length} chats for ${accountEmail}`);

    for (const chat of chats) {
      stats.chats_scanned++;
      const chatId = chat.id as string;
      if (!chatId) continue;

      try {
        // Per Unipile v2 SDK chat object: content_type='inmail' and
        // folder='INBOX_LINKEDIN_RECRUITER' are the canonical InMail
        // markers. account_type alone is NOT a signal — a Recruiter
        // seat handles Classic DMs too.
        const folders = ((chat.folder ?? []) as string[]).map((f) => String(f).toUpperCase());
        const contentType = String(chat.content_type ?? "").toLowerCase();
        const isInMail =
          contentType === "inmail" ||
          folders.includes("INBOX_LINKEDIN_RECRUITER");
        const channel = canonicalChannel(isInMail ? "linkedin_recruiter" : "linkedin");

        const attendees: any[] = chat.attendees ?? chat.members ?? [];
        const otherAttendee = attendees.find(
          (a: any) =>
            a.id !== account.unipile_account_id &&
            !String(a.id ?? "").includes(account.unipile_account_id),
        );
        // Use attendee_provider_id from chat (top-level) as fallback — more reliable for InMails
        const otherUnipileId =
          otherAttendee?.provider_id ?? otherAttendee?.id ??
          chat.attendee_provider_id ?? null;
        const otherUrl = otherAttendee?.url ?? otherAttendee?.profile_url ?? null;

        const entity = await findEntity(supabase, otherUnipileId, otherUrl);

        // Stamp the appropriate unipile ID column when we match an entity
        if (entity && otherUnipileId) {
          const table = entity.type === "candidate" ? "candidates" : "contacts";
          const idColumn = channel === "linkedin_recruiter"
            ? "unipile_recruiter_id"
            : "unipile_classic_id";
          const { data: current } = await supabase
            .from(table)
            .select(idColumn)
            .eq("id", entity.id)
            .maybeSingle();
          if (!current?.[idColumn]) {
            await supabase
              .from(table)
              .update({ [idColumn]: otherUnipileId, updated_at: new Date().toISOString() } as any)
              .eq("id", entity.id);
          }
        }

        const conversationId = await upsertConversation(
          supabase, chatId, entity, channel, account.id,
          contentType || null,
        );

        // Fetch messages (only latest 20 since this runs every 5 min).
        // v2 path: GET /api/v2/{account_id}/chats/{chat_id}/messages
        let msgsData: any;
        try {
          msgsData = await unipileFetch(
            supabase,
            account.unipile_account_id,
            `chats/${encodeURIComponent(chatId)}/messages`,
            { method: "GET", query: { limit: 20 } },
          );
        } catch {
          stats.errors++;
          continue;
        }
        const messages = msgsData.items ?? msgsData.messages ?? msgsData.data ?? [];

        // Batch dedup: load all known unipile_message_ids for this chat in one query
        const pageMsgIds = messages.map((m: any) => m.id).filter(Boolean);
        const existingMsgIds = new Set<string>();
        if (pageMsgIds.length > 0) {
          const { data: existing } = await supabase
            .from("messages")
            .select("unipile_message_id")
            .in("unipile_message_id", pageMsgIds);
          for (const row of existing ?? []) {
            if (row.unipile_message_id) existingMsgIds.add(row.unipile_message_id);
          }
        }

        for (const msg of messages) {
          stats.messages_scanned++;
          const msgId = msg.id as string;
          if (!msgId) continue;

          if (existingMsgIds.has(msgId)) {
            stats.skipped++;
            continue;
          }

          const isSender =
            msg.is_sender === true || msg.is_sender === 1 ||
            msg.sender_id === account.unipile_account_id;
          const direction = isSender ? "outbound" : "inbound";
          const sentAt = msg.timestamp ?? msg.sent_at ?? msg.created_at ?? new Date().toISOString();
          const body = msg.text ?? msg.body ?? msg.content ?? "";
          const senderAddress = isSender
            ? accountEmail
            : (otherUrl ?? otherUnipileId ?? null);

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

          if (insertErr) {
            logger.error("Message insert error", { error: insertErr.message });
            stats.errors++;
          } else {
            stats.inserted++;
          }
        }

        // Update conversation with latest message
        if (messages.length > 0) {
          const latest = messages[0];
          await supabase
            .from("conversations")
            .update({
              last_message_preview: (latest.text ?? latest.body ?? "").slice(0, 500),
              last_message_at: new Date(
                latest.timestamp ?? latest.sent_at ?? Date.now(),
              ).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", conversationId);
        }
      } catch (err: any) {
        logger.error(`Chat ${chatId} error`, { error: err.message });
        stats.errors++;
      }
    }

    logger.info("LinkedIn backfill complete", { account: accountEmail, ...stats });
    return { account: accountEmail, stats };
  },
});
