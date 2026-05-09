import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import { unipileFetch, canonicalChannel } from "../../../../src/trigger/lib/unipile-v2.js";

const BATCH_SIZE = 20;
const DELAY_MS = 400;

/**
 * Sync recent LinkedIn conversations from Unipile so the Inbox stays
 * current without relying solely on webhooks. For each active LinkedIn
 * account, walks inboxes → chats → messages and upserts conversations
 * + messages into Supabase.
 *
 * Every 2 hours. Ported from `src/trigger/sync-conversations.ts` —
 * Inngest is the only scheduler now.
 */
export const syncConversations = inngest.createFunction(
  { id: "sync-conversations", name: "Sync LinkedIn conversations from Unipile (Inngest)" },
  { cron: "0 0/2 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

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
      const channelBucket = canonicalChannel(
        account.account_type === "linkedin_recruiter" ? "linkedin_recruiter" : "linkedin",
      );
      try {
        let data: any;
        try {
          const inboxesResp: any = await unipileFetch(
            supabase,
            account.unipile_account_id,
            `inboxes`,
            { method: "GET" },
          );
          const inboxes: any[] = inboxesResp.items ?? inboxesResp.inboxes ?? inboxesResp.data ?? [];
          const collected: any[] = [];
          for (const ib of inboxes) {
            if (collected.length >= BATCH_SIZE) break;
            const inboxId = ib.id ?? ib.inbox_id ?? ib.name;
            if (!inboxId) continue;
            const remaining = BATCH_SIZE - collected.length;
            const chatsResp: any = await unipileFetch(
              supabase,
              account.unipile_account_id,
              `inboxes/${encodeURIComponent(inboxId)}/chats`,
              { method: "GET", query: { limit: remaining, sort: "latest" } },
            );
            const items = chatsResp.items ?? chatsResp.chats ?? chatsResp.data ?? [];
            for (const c of items) {
              collected.push(c);
              if (collected.length >= BATCH_SIZE) break;
            }
          }
          data = { items: collected };
        } catch (err: any) {
          logger.warn("Failed to fetch chats", { accountId: account.id, error: err.message });
          continue;
        }

        const conversations = data.items || data || [];

        for (const conv of conversations) {
          const convId = conv.id;
          if (!convId) continue;

          const attendees = conv.attendees || conv.participants || [];
          const otherParty = attendees.find((a: any) => !a.is_self && !a.is_me);
          const providerId = otherParty?.provider_id || otherParty?.id;

          if (!providerId) continue;

          const { data: candidateChannel } = await supabase
            .from("candidate_channels")
            .select("candidate_id")
            .eq("provider_id", providerId)
            .eq("channel", "linkedin")
            .maybeSingle();

          const { data: contactChannel } = await supabase
            .from("contact_channels")
            .select("contact_id")
            .eq("provider_id", providerId)
            .eq("channel", "linkedin")
            .maybeSingle();

          if (!candidateChannel && !contactChannel) continue;

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

          let msgData: any = null;
          try {
            msgData = await unipileFetch(
              supabase,
              account.unipile_account_id,
              `chats/${encodeURIComponent(convId)}/messages`,
              { method: "GET", query: { limit: 10 } },
            );
          } catch (err: any) {
            logger.warn("Failed to fetch chat messages", { convId, error: err.message });
          }

          if (msgData) {
            const messages = msgData.items || msgData || [];

            for (const msg of messages) {
              if (!msg.id) continue;

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
);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
