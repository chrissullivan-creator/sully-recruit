import { inngest } from "../client.js";
import { getSupabaseAdmin, getAppSetting } from "../../../../src/server-lib/supabase.js";
import { unipileFetchV2, canonicalChannel } from "../../../../src/server-lib/unipile-v2.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

/**
 * Backfill LinkedIn messages from the Unipile **v2** API every 5 minutes.
 *
 * The v1 DSN workspace is dead/empty — every LinkedIn account now lives on
 * the v2 app (api.unipile.com/v2), addressed by the canonical `acc_xxx` id
 * stored in integration_accounts.unipile_account_id_v2. The legacy
 * `backfill-linkedin-messages.ts` (v1, short id, `/chats`) is left untouched;
 * this is its v2 sibling.
 *
 * Mirrors backfill-emails.ts's processAccountV2 for the v2 fetch / dedup /
 * conversation+message contract, and produces the SAME messages/conversations
 * row shape as the v1 LinkedIn path (channel='linkedin', unipile_message_id /
 * unipile_chat_id set, provider='unipile') so the Inbox UI renders it
 * identically.
 *
 * v2 LinkedIn shape (verified live):
 *   GET /v2/{acc}/inboxes
 *     → { data: [ { object:"Inbox", id:"CLASSIC_PRIMARY"|..., disabled:bool } ] }
 *   GET /v2/{acc}/inboxes/{inbox_id}/chats?limit=N
 *     → { data: [ { object:"Chat", id, name, is_1to1, type, unread_count,
 *                   provider:"linkedin", last_message_timestamp,
 *                   user: { id (counterparty member id "ACoAAA..."),
 *                           display_name, profile_url } } ], cursor }
 *   GET /v2/{acc}/chats/{chat_id}/messages?limit=N    (chat_id MUST be URL-encoded)
 *     → { data: [ { object:"Message", id, sender_id, chat_id, timestamp (ISO),
 *                   is_sender (true = outbound), text, attachments:[] } ] }
 *
 * Counterparty → person: chat.user.id (LinkedIn member id) matched against
 * candidate_channels.provider_id WHERE channel='linkedin'.
 *
 * Per-account work is bounded (the v2 endpoints are slow): a couple of pages
 * of chats per inbox, a recent-window filter on each chat, and ~10 messages
 * per chat. Idempotent on external_message_id, so re-runs are safe.
 */

const MAX_CHAT_PAGES = 1; // one page (25 newest chats) per inbox per run — v2 is rate-limited
const CHATS_PER_PAGE = 25;
const MESSAGES_PER_CHAT = 10;
const RECENT_DAYS = 3; // only pull chats whose last message is within this window

/**
 * Unipile exposes ~14 LinkedIn inboxes per account: the CLASSIC_* set plus
 * eight RECRUITER_* views (UNREAD / ACCEPTED / DECLINED / UNRESPONDED / …)
 * that are just FILTERED subsets of RECRUITER_PRIMARY. Scanning all of them
 * every run blew through Unipile's ~100-request/window cap (429
 * api/too_many_requests); and because CLASSIC_* is iterated first, the
 * recruiter inboxes were starved of budget — so Recruiter InMail never got
 * ingested. Scan only the SUPERSET inboxes that hold distinct conversations.
 */
const INBOXES_TO_SCAN = new Set([
  "CLASSIC_PRIMARY", // regular DMs
  "CLASSIC_INMAIL", // classic InMail
  "CLASSIC_ARCHIVED", // archived DMs
  "RECRUITER_PRIMARY", // ALL recruiter chats (other RECRUITER_* are filtered views of this)
]);

/** A Unipile v2 429 (rate limit). unipileFetchV2 throws "Unipile v2 429 …". */
function isRateLimitError(err: any): boolean {
  return /Unipile v2 429\b/.test(String(err?.message || ""));
}

/** Classify a v2 chat into our channel bucket. v2 marks Recruiter InMail via
 *  the chat id prefix ("RECRUITER_…"), the `folders` array, or the source
 *  inbox — NOT via chat.type (which is just "1to1"). The old type/content_type
 *  check is kept as a fallback. */
function channelForChat(inboxId: string, chat: any): string {
  const id = String(chat?.id ?? "").toUpperCase();
  const folders = (Array.isArray(chat?.folders) ? chat.folders : []).map((f: any) =>
    String(f).toUpperCase(),
  );
  const contentType = String(chat?.type ?? chat?.content_type ?? "").toLowerCase();
  const isRecruiter =
    inboxId.toUpperCase().startsWith("RECRUITER") ||
    id.startsWith("RECRUITER_") ||
    folders.some((f: string) => f.includes("RECRUITER")) ||
    contentType === "inmail" ||
    contentType.includes("recruiter");
  return canonicalChannel(isRecruiter ? "linkedin_recruiter" : "linkedin");
}

/** Inboxes we pull from. CLASSIC_PRIMARY is the regular DM inbox; the others
 *  cover archived / other surfaces. We pull whatever is enabled (not
 *  `disabled`) but always include CLASSIC_PRIMARY when present. */
function isEnabledInbox(inbox: any): boolean {
  if (!inbox?.id) return false;
  return inbox.disabled !== true;
}

interface MatchedEntity {
  type: "candidate" | "contact";
  id: string;
  owner_user_id: string | null;
}

/** Match a LinkedIn member id (e.g. "ACoAAA...") to a person via the
 *  candidate_channels cache. channel='linkedin', provider_id = member id.
 *  candidate_channels backs both candidates and (type='client') contacts;
 *  resolve the person's type so we set the right FK column. */
async function matchByMemberId(
  supabase: any,
  memberId: string | null,
): Promise<MatchedEntity | null> {
  if (!memberId) return null;
  const { data: ch } = await supabase
    .from("candidate_channels")
    .select("candidate_id")
    .eq("channel", "linkedin")
    .eq("provider_id", memberId)
    .limit(1)
    .maybeSingle();
  const candidateId = ch?.candidate_id;
  if (!candidateId) return null;

  const { data: person } = await supabase
    .from("people")
    .select("id, type, owner_user_id")
    .eq("id", candidateId)
    .maybeSingle();
  if (!person) return null;
  const type: "candidate" | "contact" = person.type === "client" ? "contact" : "candidate";
  return { type, id: person.id, owner_user_id: person.owner_user_id ?? null };
}

/** Upsert a conversation for a LinkedIn chat. Mirrors the v1 LinkedIn path's
 *  upsertConversation (same onConflict + column shape) so the two backfills
 *  converge on one conversation row per chat. */
async function upsertConversation(
  supabase: any,
  chatId: string,
  entity: MatchedEntity | null,
  channel: string,
  integrationAccountId: string,
): Promise<string | null> {
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

  if (error || !created) {
    throw new Error(`Conversation upsert failed: ${error?.message}`);
  }
  return created.id;
}

async function processAccountV2(
  supabase: any,
  account: any,
  logger: any,
): Promise<{
  inboxes: number;
  chats_scanned: number;
  messages_scanned: number;
  inserted: number;
  skipped: number;
  unmatched: number;
  errors: number;
}> {
  const stats = {
    inboxes: 0,
    chats_scanned: 0,
    messages_scanned: 0,
    inserted: 0,
    skipped: 0,
    unmatched: 0,
    errors: 0,
  };
  const acctV2: string | null = account.unipile_account_id_v2;
  const accountEmail: string | null = account.email_address ?? null;
  if (!acctV2) return stats; // not yet backfilled onto v2 — can't pull

  const cutoffMs = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;

  // 1) List inboxes. Be defensive: data may be under .data or a bare array.
  let inboxPayload: any;
  try {
    inboxPayload = await unipileFetchV2(supabase, acctV2, "inboxes", { method: "GET" });
  } catch (err: any) {
    logger.warn("v2 inboxes fetch failed", { email: accountEmail, error: err.message });
    const m = String(err?.message || "").match(/Unipile v2 (\d{3})/);
    const status = m ? Number(m[1]) : null;
    const is5xx = status !== null && status >= 500 && status <= 599;
    // 429 = rate-limited (expected backpressure), 5xx = transient — don't alert.
    if (!is5xx && status !== 429) {
      await notifyError({
        taskId: "backfill-linkedin-messages-v2",
        severity: "ERROR",
        error: err,
        context: { accountId: account.id, email: accountEmail, api: "v2", status },
      });
    }
    return stats;
  }
  const inboxes: any[] = Array.isArray(inboxPayload?.data)
    ? inboxPayload.data
    : Array.isArray(inboxPayload)
      ? inboxPayload
      : (inboxPayload?.items ?? []);
  const enabledInboxes = inboxes.filter((i) => isEnabledInbox(i) && INBOXES_TO_SCAN.has(i.id));
  // Always include CLASSIC_PRIMARY even if the list shape surprised us.
  if (!enabledInboxes.some((i) => i.id === "CLASSIC_PRIMARY")) {
    enabledInboxes.push({ id: "CLASSIC_PRIMARY" });
  }

  let rateLimited = false;
  for (const inbox of enabledInboxes) {
    if (rateLimited) break;
    const inboxId = inbox.id as string;
    if (!inboxId) continue;
    stats.inboxes++;

    // 2) List recent chats in this inbox, bounded to a couple of pages.
    let cursor: string | undefined;
    let pages = 0;
    let reachedOld = false;
    while (pages < MAX_CHAT_PAGES && !reachedOld) {
      let chatPayload: any;
      try {
        chatPayload = await unipileFetchV2(
          supabase,
          acctV2,
          `inboxes/${encodeURIComponent(inboxId)}/chats`,
          { method: "GET", query: { limit: CHATS_PER_PAGE, ...(cursor ? { cursor } : {}) } },
        );
      } catch (err: any) {
        if (isRateLimitError(err)) {
          rateLimited = true;
          logger.warn("v2 rate-limited fetching chats — backing off this run", { email: accountEmail, inbox: inboxId });
          break;
        }
        logger.warn("v2 chats fetch failed", { email: accountEmail, inbox: inboxId, error: err.message });
        stats.errors++;
        break;
      }
      pages++;
      const chats: any[] = Array.isArray(chatPayload?.data)
        ? chatPayload.data
        : Array.isArray(chatPayload)
          ? chatPayload
          : (chatPayload?.items ?? chatPayload?.chats ?? []);
      if (chats.length === 0) break;

      for (const chat of chats) {
        stats.chats_scanned++;
        const chatId = chat.id as string;
        if (!chatId) continue;

        // Recent-window filter: skip chats with no activity in the window.
        // v2 sorts newest-first, so once we cross the cutoff we can stop
        // paging this inbox.
        const lastTs = chat.last_message_timestamp ?? chat.last_message_at ?? null;
        const lastMs = lastTs ? new Date(lastTs).getTime() : NaN;
        if (!Number.isNaN(lastMs) && lastMs < cutoffMs) {
          reachedOld = true;
          continue;
        }

        try {
          // Activity gate: skip the (rate-limited) messages fetch entirely when
          // this chat has no new activity since we last ingested it. The DB
          // lookup is free; the Unipile messages call is the scarce resource.
          if (!Number.isNaN(lastMs)) {
            const { data: lastStored } = await supabase
              .from("messages")
              .select("sent_at")
              .eq("external_conversation_id", chatId)
              .order("sent_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (lastStored?.sent_at && new Date(lastStored.sent_at).getTime() >= lastMs) {
              continue; // nothing new in this chat
            }
          }

          // Recruiter InMail vs Classic DM: v2 marks recruiter via the chat id
          // prefix / folders / source inbox, NOT chat.type (which is "1to1").
          const channel = channelForChat(inboxId, chat);

          // Counterparty is chat.user (the 1:1 member). Fall back to
          // attendee-ish fields for non-standard shapes.
          const counterparty = chat.user ?? chat.attendee ?? null;
          const memberId: string | null =
            counterparty?.id ?? chat.attendee_provider_id ?? chat.provider_id ?? null;
          const profileUrl: string | null =
            counterparty?.profile_url ?? counterparty?.url ?? null;

          const entity = await matchByMemberId(supabase, memberId);
          if (!entity) stats.unmatched++;

          const conversationId = await upsertConversation(
            supabase,
            chatId,
            entity,
            channel,
            account.id,
          );
          if (!conversationId) {
            stats.errors++;
            continue;
          }

          // 3) Fetch the chat's recent messages. chat_id has base64 chars
          // (incl. '=') — MUST be URL-encoded.
          let msgPayload: any;
          try {
            msgPayload = await unipileFetchV2(
              supabase,
              acctV2,
              `chats/${encodeURIComponent(chatId)}/messages`,
              { method: "GET", query: { limit: MESSAGES_PER_CHAT } },
            );
          } catch (err: any) {
            if (isRateLimitError(err)) {
              rateLimited = true;
              logger.warn("v2 rate-limited fetching messages — backing off this run", { chat: chatId });
              break;
            }
            logger.warn("v2 messages fetch failed", { chat: chatId, error: err.message });
            stats.errors++;
            continue;
          }
          const messages: any[] = Array.isArray(msgPayload?.data)
            ? msgPayload.data
            : Array.isArray(msgPayload)
              ? msgPayload
              : (msgPayload?.items ?? msgPayload?.messages ?? []);

          // Dedup on external_message_id (mirrors backfill-emails). We also
          // write unipile_message_id for the Inbox/v1-path parity.
          const pageMsgIds = messages.map((m) => m.id).filter(Boolean) as string[];
          const existingIds = new Set<string>();
          if (pageMsgIds.length > 0) {
            const { data: existing } = await supabase
              .from("messages")
              .select("external_message_id")
              .in("external_message_id", pageMsgIds);
            for (const row of existing ?? []) {
              if (row.external_message_id) existingIds.add(row.external_message_id);
            }
          }

          for (const msg of messages) {
            stats.messages_scanned++;
            const msgId = msg.id as string;
            if (!msgId) {
              stats.skipped++;
              continue;
            }
            if (existingIds.has(msgId)) {
              stats.skipped++;
              continue;
            }

            // is_sender: true = sent BY the account owner = outbound.
            const isSender = msg.is_sender === true || msg.is_sender === 1;
            const direction = isSender ? "outbound" : "inbound";
            const sentAtIso = new Date(
              msg.timestamp ?? msg.sent_at ?? msg.created_at ?? Date.now(),
            ).toISOString();
            const body = msg.text ?? msg.body ?? msg.content ?? "";
            const senderAddress = isSender ? accountEmail : (profileUrl ?? memberId ?? null);
            const nowIso = new Date().toISOString();

            const { error: insertErr } = await supabase.from("messages").insert({
              conversation_id: conversationId,
              candidate_id: entity?.type === "candidate" ? entity.id : null,
              contact_id: entity?.type === "contact" ? entity.id : null,
              integration_account_id: account.id,
              channel,
              direction,
              body,
              provider: "unipile",
              external_message_id: msgId,
              external_conversation_id: chatId,
              unipile_message_id: msgId,
              unipile_chat_id: chatId,
              sender_address: senderAddress,
              sent_at: sentAtIso,
              is_read: true,
              created_at: nowIso,
              updated_at: nowIso,
              inserted_at: nowIso,
            });

            if (insertErr) {
              logger.error("v2 LinkedIn message insert error", { error: insertErr.message });
              stats.errors++;
            } else {
              stats.inserted++;
            }
          }

          // Refresh the conversation preview from the newest message.
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
          logger.error(`v2 chat ${chatId} error`, { error: err.message });
          stats.errors++;
        }
      }

      if (rateLimited) break;
      cursor = chatPayload?.cursor || chatPayload?.next_cursor || chatPayload?.next || undefined;
      if (!cursor) break;
    }
  }

  return stats;
}

export const backfillLinkedinMessagesV2 = inngest.createFunction(
  { id: "backfill-linkedin-messages-v2", name: "Backfill LinkedIn messages from Unipile v2 (Inngest)" },
  // Every 15 min (offset from the other crons). Unipile v2 caps LinkedIn at
  // ~100 requests/window per account and that budget is shared with the other
  // LinkedIn crons; every-5-min runs across ~14 inboxes were tripping 429s.
  // Real-time inbound still arrives via the Unipile webhook — this is the net.
  { cron: "8-53/15 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    // Kill switch — set app_settings.BACKFILL_LINKEDIN_V2_PAUSED to "true"
    // to no-op this cron without a deploy (e.g. during a Unipile incident).
    const pausedSetting = (await getAppSetting("BACKFILL_LINKEDIN_V2_PAUSED")).toLowerCase();
    if (pausedSetting === "true" || pausedSetting === "1" || pausedSetting === "on") {
      logger.info("backfill-linkedin-messages-v2 paused via app_settings.BACKFILL_LINKEDIN_V2_PAUSED");
      return { paused: true };
    }

    // Every active LinkedIn account that has been backfilled onto v2
    // (unipile_account_id_v2 set). Accounts still missing the acc_xxx id
    // can't be pulled on v2 yet — skip them (the v1 cron covers nothing
    // now, but we don't error on them here).
    const { data: accounts, error: acctErr } = await supabase
      .from("integration_accounts")
      .select("id, email_address, owner_user_id, account_type, unipile_account_id_v2, unipile_provider")
      .eq("unipile_provider", "LINKEDIN")
      .eq("is_active", true)
      .not("unipile_account_id_v2", "is", null);

    if (acctErr) {
      logger.error("LinkedIn v2 account lookup failed", { error: acctErr.message });
      await notifyError({ taskId: "backfill-linkedin-messages-v2", error: acctErr, severity: "ERROR" });
      return { error: acctErr.message };
    }
    if (!accounts?.length) {
      logger.warn("No LinkedIn accounts with unipile_account_id_v2 configured");
      return { error: "no_v2_linkedin_accounts" };
    }

    const perAccount: Array<{ account: string; stats: any }> = [];
    for (const account of accounts) {
      const label = account.email_address ?? account.id;
      try {
        const stats = await processAccountV2(supabase, account, logger);
        perAccount.push({ account: label, stats });
        logger.info(`Processed LinkedIn v2 for ${label}`, stats);
      } catch (err: any) {
        logger.error("LinkedIn v2 backfill failed for account", { account: label, error: err.message });
        perAccount.push({ account: label, stats: { error: err.message } });
      }
    }

    const totalInserted = perAccount.reduce((s, r: any) => s + (r.stats?.inserted ?? 0), 0);
    const totalUnmatched = perAccount.reduce((s, r: any) => s + (r.stats?.unmatched ?? 0), 0);
    logger.info("LinkedIn v2 backfill complete", { totalInserted, totalUnmatched, accounts: perAccount.length });

    return { perAccount, totalInserted, totalUnmatched };
  },
);
