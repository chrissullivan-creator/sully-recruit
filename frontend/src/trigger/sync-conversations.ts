import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { unipileFetch, canonicalChannel } from "./lib/unipile-v2";

const BATCH_SIZE = 20;
const DELAY_MS = 400;

/**
 * Scheduled task: sync recent LinkedIn conversations from Unipile.
 *
 * Pulls the latest conversations and messages so the Inbox stays
 * current without relying solely on webhooks.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: sync-conversations
 *   Cron: 0 0/2 * * * (every 2 hours)
 */
export const syncConversations = schedules.task({
  id: "sync-conversations",
  maxDuration: 240,
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Get active LinkedIn accounts. Each row gets its own v2 sweep —
    // account_id moves into the URL path in v2 (no more query param).
    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, owner_user_id, account_type")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts?.length) {
      logger.info("No active LinkedIn accounts — skipping sync");
      return { synced: 0, messages: 0 };
    }

    let totalSynced = 0;
    let totalMessages = 0;

    for (const account of accounts) {
      // Bucket inbound LinkedIn conversations: recruiter accounts produce
      // InMails (linkedin_recruiter), classic accounts produce regular
      // LinkedIn messages (linkedin).
      const channelBucket = canonicalChannel(
        account.account_type === "linkedin_recruiter" ? "linkedin_recruiter" : "linkedin",
      );
      try {
        // v2 path: GET /api/v2/chats?account_id=…&limit&sort
        let data: any;
        try {
          data = await unipileFetch(
            supabase,
            account.unipile_account_id,
            `chats`,
            {
              method: "GET",
              topLevel: true,
              query: { limit: BATCH_SIZE, sort: "latest" },
            },
          );
        } catch (err: any) {
          logger.warn("Failed to fetch chats", { accountId: account.id, error: err.message });
          continue;
        }

        const conversations = data.items || data || [];

        for (const conv of conversations) {
          const convId = conv.id;
          if (!convId) continue;

          // Match conversation to a candidate or contact by provider_id
          const attendees = conv.attendees || conv.participants || [];
          const otherParty = attendees.find((a: any) => !a.is_self && !a.is_me);
          const providerId = otherParty?.provider_id || otherParty?.id;

          if (!providerId) continue;

          // Look up in candidate_channels
          const { data: candidateChannel } = await supabase
            .from("candidate_channels")
            .select("candidate_id")
            .eq("provider_id", providerId)
            .eq("channel", "linkedin")
            .maybeSingle();

          // Look up in contact_channels
          const { data: contactChannel } = await supabase
            .from("contact_channels")
            .select("contact_id")
            .eq("provider_id", providerId)
            .eq("channel", "linkedin")
            .maybeSingle();

          if (!candidateChannel && !contactChannel) continue;

          // Upsert conversation record. Bucket using channelBucket so
          // recruiter InMails go to linkedin_recruiter and classic
          // chats go to linkedin (matches sequence-scheduler writes).
          const convRecord: any = {
            external_conversation_id: convId,
            channel: channelBucket,
            last_message_at: conv.last_message_at || conv.updated_at,
            last_message_preview: conv.last_message_preview || conv.snippet,
            account_id: account.id,
          };
          if (candidateChannel) convRecord.candidate_id = candidateChannel.candidate_id;
          if (contactChannel) convRecord.contact_id = contactChannel.contact_id;

          await supabase
            .from("conversations")
            .upsert(convRecord, { onConflict: "external_conversation_id" });

          // Update the channel record with conversation ID
          if (candidateChannel) {
            await supabase
              .from("candidate_channels")
              .update({ external_conversation_id: convId } as any)
              .eq("candidate_id", candidateChannel.candidate_id)
              .eq("channel", "linkedin");
          }
          if (contactChannel) {
            await supabase
              .from("contact_channels")
              .update({ external_conversation_id: convId } as any)
              .eq("contact_id", contactChannel.contact_id)
              .eq("channel", "linkedin");
          }

          // Fetch latest messages for this conversation.
          // v2 path: GET /api/v2/chats/{chat_id}/messages?account_id=…
          let msgData: any = null;
          try {
            msgData = await unipileFetch(
              supabase,
              account.unipile_account_id,
              `chats/${encodeURIComponent(convId)}/messages`,
              {
                method: "GET",
                topLevel: true,
                query: { limit: 10 },
              },
            );
          } catch (err: any) {
            logger.warn("Failed to fetch chat messages", { convId, error: err.message });
          }

          if (msgData) {
            const messages = msgData.items || msgData || [];

            for (const msg of messages) {
              if (!msg.id) continue;

              // Skip if already stored
              const { data: existing } = await supabase
                .from("messages")
                .select("id")
                .eq("external_message_id", msg.id)
                .maybeSingle();

              if (existing) continue;

              await supabase.from("messages").insert({
                conversation_id: convId,
                candidate_id: candidateChannel?.candidate_id || null,
                contact_id: contactChannel?.contact_id || null,
                channel: channelBucket,
                direction: msg.is_sender ? "outbound" : "inbound",
                body: msg.text || msg.body,
                sender_name: msg.sender_name,
                sent_at: msg.timestamp || msg.created_at,
                external_message_id: msg.id,
                external_conversation_id: convId,
                provider: "unipile",
              } as any);

              totalMessages++;
            }
          }

          totalSynced++;
          await delay(DELAY_MS);
        }
      } catch (err: any) {
        logger.error("Conversation sync error", { accountId: account.id, error: err.message });
      }
    }

    logger.info("Conversation sync complete", { synced: totalSynced, messages: totalMessages });
    return { synced: totalSynced, messages: totalMessages };
  },
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
