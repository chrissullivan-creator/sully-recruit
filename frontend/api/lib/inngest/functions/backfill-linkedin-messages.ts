import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { normalizeLinkedIn } from "../../../../src/server-lib/resume-parsing.js";
import { unipileFetch, canonicalChannel } from "../../../../src/server-lib/unipile-v2.js";

/**
 * Backfill LinkedIn messages from Unipile every 5 minutes for every
 * LinkedIn-Recruiter account in the firm. Was 3 separate Trigger.dev
 * schedules (one per recruiter) — Inngest runs them all in one cron
 * since the per-account work is sequential and cheap.
 *
 * Per-account cap: 20 chats per run × ~20 messages each = ~400 inserts
 * worst case. Idempotent on (unipile_message_id, conversation external
 * id), so re-runs are safe.
 *
 * Ported from `src/trigger/backfill-linkedin-messages.ts` — Inngest is
 * the only scheduler now.
 */

const RECRUITER_EMAILS = [
  "chris.sullivan@emeraldrecruit.com",
  "nancy.eberlein@emeraldrecruit.com",
  "ashley.leichner@emeraldrecruit.com",
];
const MAX_CHATS_PER_ACCOUNT = 20;

async function findEntity(
  supabase: any,
  unipileId: string | null,
  linkedinUrl: string | null,
): Promise<{ type: string; id: string; owner_user_id: string | null } | null> {
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
  // .limit(1) instead of .maybeSingle() — historical duplicates would
  // make maybeSingle() return null on multi-match and trigger a fresh
  // INSERT. The DB-level UNIQUE index (uniq_conversations_external_id)
  // now blocks that, but the lookup must still tolerate any leftover.
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("external_conversation_id", chatId)
    .eq("integration_account_id", integrationAccountId)
    .eq("channel", channel)
    .order("created_at", { ascending: true })
    .limit(1);
  if (existing && existing.length > 0) return existing[0].id;

  const now = new Date().toISOString();
  const { data: created, error } = await supabase
    .from("conversations")
    .upsert(
      {
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
      },
      { onConflict: "integration_account_id,channel,external_conversation_id" },
    )
    .select("id")
    .single();

  if (error || !created) throw new Error(`Conversation upsert failed: ${error?.message}`);
  return created.id;
}

async function backfillOne(
  supabase: any,
  accountEmail: string,
  logger: any,
): Promise<{
  chats_scanned: number;
  messages_scanned: number;
  inserted: number;
  skipped: number;
  errors: number;
}> {
  const stats = { chats_scanned: 0, messages_scanned: 0, inserted: 0, skipped: 0, errors: 0 };

  // Filter by account_type — each recruiter has multiple rows
  // (email / linkedin_recruiter / phone / sms) sharing email_address.
  const { data: account } = await supabase
    .from("integration_accounts")
    .select("id, email_address, unipile_account_id, owner_user_id, account_type")
    .eq("email_address", accountEmail)
    .eq("account_type", "linkedin_recruiter")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .maybeSingle();

  if (!account?.unipile_account_id) {
    logger.warn(`No Unipile account for ${accountEmail}`);
    return stats;
  }

  // v1 has no inbox concept — list chats directly. The Recruiter
  // vs Classic distinction is on the chat row itself (folder /
  // content_type), so the per-inbox loop we used to do on v2 was
  // a v2-specific hack.
  const chats: any[] = [];
  try {
    const data: any = await unipileFetch(
      supabase,
      account.unipile_account_id,
      `chats`,
      { method: "GET", query: { limit: MAX_CHATS_PER_ACCOUNT } },
    );
    const items = data.items ?? data.chats ?? data.data ?? [];
    for (const c of items) {
      chats.push(c);
      if (chats.length >= MAX_CHATS_PER_ACCOUNT) break;
    }
  } catch (err: any) {
    logger.warn("chats fetch failed", { account_id: account.unipile_account_id, error: err.message });
  }

  logger.info(`Fetched ${chats.length} chats for ${accountEmail}`);

  for (const chat of chats) {
    stats.chats_scanned++;
    const chatId = chat.id as string;
    if (!chatId) continue;

    try {
      const folders = ((chat.folder ?? []) as string[]).map((f) => String(f).toUpperCase());
      const contentType = String(chat.content_type ?? "").toLowerCase();
      const isInMail = contentType === "inmail" || folders.includes("INBOX_LINKEDIN_RECRUITER");
      const channel = canonicalChannel(isInMail ? "linkedin_recruiter" : "linkedin");

      const attendees: any[] = chat.attendees ?? chat.members ?? [];
      const otherAttendee = attendees.find(
        (a: any) =>
          a.id !== account.unipile_account_id &&
          !String(a.id ?? "").includes(account.unipile_account_id),
      );
      const otherUnipileId =
        otherAttendee?.provider_id ?? otherAttendee?.id ?? chat.attendee_provider_id ?? null;
      const otherUrl = otherAttendee?.url ?? otherAttendee?.profile_url ?? null;

      const entity = await findEntity(supabase, otherUnipileId, otherUrl);

      if (entity && otherUnipileId) {
        const table = entity.type === "candidate" ? "candidates" : "contacts";
        const idColumn =
          channel === "linkedin_recruiter" ? "unipile_recruiter_id" : "unipile_classic_id";
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
        supabase,
        chatId,
        entity,
        channel,
        account.id,
        contentType || null,
      );

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
          msg.is_sender === true ||
          msg.is_sender === 1 ||
          msg.sender_id === account.unipile_account_id;
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
          provider: "unipile",
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

      if (messages.length > 0) {
        const latest = messages[0];
        await supabase
          .from("conversations")
          .update({
            last_message_preview: (latest.text ?? latest.body ?? "").slice(0, 500),
            last_message_at: new Date(latest.timestamp ?? latest.sent_at ?? Date.now()).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", conversationId);
      }
    } catch (err: any) {
      logger.error(`Chat ${chatId} error`, { error: err.message });
      stats.errors++;
    }
  }

  return stats;
}

export const backfillLinkedinMessages = inngest.createFunction(
  { id: "backfill-linkedin-messages", name: "Backfill LinkedIn messages from Unipile (Inngest)" },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const perAccount: Array<{ account: string; stats: any }> = [];

    for (const accountEmail of RECRUITER_EMAILS) {
      try {
        const stats = await backfillOne(supabase, accountEmail, logger);
        perAccount.push({ account: accountEmail, stats });
      } catch (err: any) {
        logger.error("Backfill failed for account", { account: accountEmail, error: err.message });
        perAccount.push({ account: accountEmail, stats: { error: err.message } });
      }
    }

    logger.info("LinkedIn backfill complete", { perAccount });
    return { perAccount };
  },
);
