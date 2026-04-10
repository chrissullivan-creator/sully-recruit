import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting, getUnipileBaseUrl } from "./lib/supabase";
import { normalizeLinkedIn, delay } from "./lib/resume-parsing";

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
  if (unipileId) {
    const { data } = await supabase
      .from("candidates")
      .select("id, owner_user_id")
      .eq("unipile_id", unipileId)
      .maybeSingle();
    if (data) return { type: "candidate", ...data };
  }
  if (linkedinUrl) {
    const slug = normalizeLinkedIn(linkedinUrl);
    if (slug) {
      const { data } = await supabase
        .from("candidates")
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
      .eq("unipile_id", unipileId)
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
  maxDuration: 240,
  run: async (payload) => {
    const config = LINKEDIN_ACCOUNTS[payload.externalId ?? ""] ?? LINKEDIN_ACCOUNTS["backfill-linkedin-chris"];
    const accountEmail = config.email;
    const maxChats = config.maxChats;

    const supabase = getSupabaseAdmin();
    const baseUrl = await getUnipileBaseUrl();
    const apiKey = await getAppSetting("UNIPILE_API_KEY");
    const uniHeaders = { "X-API-KEY": apiKey, Accept: "application/json" };

    const { data: account } = await supabase
      .from("integration_accounts")
      .select("id, email_address, unipile_account_id, owner_user_id")
      .eq("email_address", accountEmail)
      .eq("is_active", true)
      .not("unipile_account_id", "is", null)
      .maybeSingle();

    if (!account?.unipile_account_id) {
      logger.warn(`No Unipile account for ${accountEmail}`);
      return { error: `No Unipile account for ${accountEmail}` };
    }

    const stats = { chats_scanned: 0, messages_scanned: 0, inserted: 0, skipped: 0, errors: 0 };

    // Fetch chats from Unipile
    const chatsUrl = `${baseUrl}/api/v1/chats?account_id=${account.unipile_account_id}&limit=${maxChats}`;
    const chatsResp = await fetch(chatsUrl, { headers: uniHeaders });
    if (!chatsResp.ok) {
      const err = await chatsResp.text();
      throw new Error(`Unipile chats ${chatsResp.status}: ${err.slice(0, 200)}`);
    }

    const chatsData = await chatsResp.json();
    const chats = chatsData.items ?? chatsData.chats ?? chatsData.data ?? [];

    logger.info(`Fetched ${chats.length} chats for ${accountEmail}`);

    for (const chat of chats) {
      stats.chats_scanned++;
      const chatId = chat.id as string;
      if (!chatId) continue;

      try {
        const providerType = String(chat.provider_type ?? chat.type ?? "").toLowerCase();
        const channel = providerType.includes("sales")
          ? "linkedin_sales_nav"
          : providerType.includes("recruiter")
            ? "linkedin_recruiter"
            : "linkedin";

        const attendees: any[] = chat.attendees ?? chat.members ?? [];
        const otherAttendee = attendees.find(
          (a: any) =>
            a.id !== account.unipile_account_id &&
            !String(a.id ?? "").includes(account.unipile_account_id),
        );
        const otherUnipileId = otherAttendee?.provider_id ?? otherAttendee?.id ?? null;
        const otherUrl = otherAttendee?.url ?? otherAttendee?.profile_url ?? null;

        const entity = await findEntity(supabase, otherUnipileId, otherUrl);

        // Stamp unipile_id if we found a match and they don't have one
        if (entity && otherUnipileId) {
          const table = entity.type === "candidate" ? "candidates" : "contacts";
          const { data: current } = await supabase
            .from(table)
            .select("unipile_id")
            .eq("id", entity.id)
            .maybeSingle();
          if (!current?.unipile_id) {
            await supabase
              .from(table)
              .update({ unipile_id: otherUnipileId, updated_at: new Date().toISOString() })
              .eq("id", entity.id);
          }
        }

        const conversationId = await upsertConversation(supabase, chatId, entity, channel, account.id);

        // Fetch messages
        const msgsResp = await fetch(
          `${baseUrl}/api/v1/chats/${chatId}/messages?account_id=${account.unipile_account_id}&limit=100`,
          { headers: uniHeaders },
        );
        if (!msgsResp.ok) {
          stats.errors++;
          continue;
        }

        const msgsData = await msgsResp.json();
        const messages = msgsData.items ?? msgsData.messages ?? msgsData.data ?? [];

        for (const msg of messages) {
          stats.messages_scanned++;
          const msgId = msg.id as string;
          if (!msgId) continue;

          // Dedup
          const { data: existing } = await supabase
            .from("messages")
            .select("id")
            .eq("unipile_message_id", msgId)
            .maybeSingle();
          if (existing) {
            stats.skipped++;
            continue;
          }

          const isSender =
            msg.is_sender === true || msg.sender_id === account.unipile_account_id;
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
