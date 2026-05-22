import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { unipileFetch } from "../../../../src/server-lib/unipile-v2.js";
import { resolvePerson } from "../../identity-resolver.js";

/**
 * Tier-1 resolver — walk existing Unipile chats and resolve the
 * counterparty straight off the chat/message payload. ZERO LinkedIn
 * profile-view cost because we never call `/users/{slug}`; everyone
 * you've ever DM'd is identified by `provider_id` + `public_identifier`
 * inside chat objects you've already paid for.
 *
 * This is the primary backfill engine for the Communication Hub. The
 * cold resolver (`resolve-unipile-ids.ts`) is the fallback for people
 * with whom there's no chat history.
 *
 * What it does, per LinkedIn account:
 *   1. Page through `/chats?account_id=X` (v1 — `unipileFetch` translates).
 *   2. For each chat, extract counterparty `provider_id` + `public_identifier`
 *      from `attendee.provider_id` / `attendee.public_identifier`.
 *   3. Resolve via `identity-resolver.resolvePerson()` (handles slug,
 *      provider_id, and the candidate_channels cache).
 *   4. On match: upsert into `candidate_channels` (cache for the next
 *      webhook hit) AND back-stamp `messages.candidate_id` /
 *      `messages.contact_id` on rows that still have `needs_link=true`
 *      for this chat (`external_conversation_id` match).
 *   5. On no match: leave the chat alone. The Communication Hub will
 *      surface it as an unresolved counterparty for the "Link to
 *      person / Create new" UI.
 *
 * Idempotent: re-running flips no rows that were already linked, and
 * the candidate_channels upsert keys on (candidate_id, channel).
 *
 * Schedule: hourly (`5 * * * *`). The first few runs do the bulk
 * backfill; steady-state runs catch new chats.
 *
 * What this is NOT: this is not a backfill of historical message
 * bodies. Messages already in `messages` get their person link
 * stamped. Message bodies that AREN'T in `messages` aren't pulled
 * here — that's the job of the v2 chat-history sync (separate task).
 */

const CHATS_PER_PAGE = 50;
const MAX_PAGES_PER_ACCOUNT = 40; // 2,000 chats/account/run ceiling
const MAX_ELAPSED_MS = 240_000;
const PAGE_DELAY_MS = 250;

type IntegrationAccount = {
  id: string;
  unipile_account_id: string;
  account_type: string | null;
  owner_user_id: string | null;
};

type ResolveCounts = {
  scanned: number;
  resolved_existing: number;
  back_stamped_messages: number;
  unresolved: number;
  errors: number;
};

export const resolveFromChats = inngest.createFunction(
  { id: "resolve-from-chats", name: "Tier-1 chat-participant resolver (Inngest)" },
  { cron: "5 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();

    const { data: accounts } = await supabase
      .from("integration_accounts")
      .select("id, unipile_account_id, account_type, owner_user_id")
      .or("account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter,account_type.eq.linkedin")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!accounts || accounts.length === 0) {
      logger.info("No active LinkedIn accounts — nothing to scan");
      return { totals: emptyCounts(), perAccount: [] };
    }

    const totals = emptyCounts();
    const perAccount: Array<{ accountId: string; counts: ResolveCounts }> = [];
    const start = Date.now();

    for (const account of accounts as IntegrationAccount[]) {
      if (Date.now() - start > MAX_ELAPSED_MS) {
        logger.warn("Time budget exhausted across accounts — stopping early", { totals });
        break;
      }
      const counts = await scanAccount(supabase, account, logger, MAX_ELAPSED_MS - (Date.now() - start));
      perAccount.push({ accountId: account.id, counts });
      mergeCounts(totals, counts);
    }

    logger.info("Tier-1 chat resolver complete", totals);
    return { totals, perAccount };
  },
);

async function scanAccount(
  supabase: any,
  account: IntegrationAccount,
  logger: any,
  timeBudgetMs: number,
): Promise<ResolveCounts> {
  const counts = emptyCounts();
  const start = Date.now();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    if (Date.now() - start > timeBudgetMs) {
      logger.warn("Per-account time budget hit — stopping", { accountId: account.id, page, counts });
      break;
    }

    let resp: any;
    try {
      const query: Record<string, string | number> = { limit: CHATS_PER_PAGE };
      if (cursor) query.cursor = cursor;
      resp = await unipileFetch(supabase, account.unipile_account_id, "chats", { method: "GET", query });
    } catch (err: any) {
      logger.warn("chats list failed", { accountId: account.id, err: String(err?.message || "").slice(0, 200) });
      counts.errors++;
      break;
    }

    const items: any[] = Array.isArray(resp?.items) ? resp.items : Array.isArray(resp) ? resp : [];
    if (items.length === 0) break;

    for (const chat of items) {
      counts.scanned++;
      await processChat(supabase, account, chat, counts, logger).catch((err) => {
        logger.warn("chat resolve failed", { chatId: chat?.id, err: String(err?.message || "").slice(0, 200) });
        counts.errors++;
      });
    }

    cursor = resp?.cursor || resp?.next_cursor || null;
    if (!cursor) break;
    await delay(PAGE_DELAY_MS);
  }

  return counts;
}

async function processChat(
  supabase: any,
  account: IntegrationAccount,
  chat: any,
  counts: ResolveCounts,
  _logger: any,
): Promise<void> {
  // Only 1:1 chats give us an unambiguous counterparty. Groups skipped.
  const attendees: any[] = Array.isArray(chat?.attendees) ? chat.attendees : [];
  const externalConversationId: string | null = chat?.id || chat?.chat_id || null;

  // Strip our own account out — `attendee.is_self` or matching the
  // account_info.user_id from the webhook payload.
  const others = attendees.filter((a: any) => a && a.is_self !== true);
  if (others.length !== 1) return;

  const counterparty = others[0];
  const providerId: string | null = counterparty?.provider_id || counterparty?.attendee_provider_id || null;
  const publicIdentifier: string | null = counterparty?.public_identifier || null;
  const linkedinUrl: string | null = counterparty?.profile_url || counterparty?.attendee_profile_url || null;

  if (!providerId && !publicIdentifier && !linkedinUrl) return;

  const match = await resolvePerson(supabase, "linkedin", {
    providerId,
    publicIdentifier,
    linkedinUrl,
  });

  if (!match) {
    counts.unresolved++;
    return;
  }

  counts.resolved_existing++;

  // Cache the resolution so the next inbound webhook hits Tier-2
  // (cheap candidate_channels lookup) instead of slug-matching again.
  await supabase
    .from("candidate_channels")
    .upsert(
      {
        candidate_id: match.personId,
        channel: "linkedin",
        provider_id: providerId,
        unipile_id: providerId,
        account_id: account.id,
        external_conversation_id: externalConversationId,
        is_connected: true,
        connection_status: "tier1_chat_resolved",
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "candidate_id,channel" },
    );

  // Back-stamp any orphaned messages on this chat. Three possible
  // selectors for the chat id since Unipile's payload shape drifted
  // between v1 and v2 — match all three.
  if (externalConversationId) {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        [match.entityColumn]: match.personId,
        needs_link: false,
        link_method: `tier1:${match.linkMethod}`,
        link_attempted_at: new Date().toISOString(),
      })
      .or(
        `external_conversation_id.eq.${externalConversationId},external_thread_id.eq.${externalConversationId},unipile_chat_id.eq.${externalConversationId}`,
      )
      .is(match.entityColumn, null)
      .select("id");
    counts.back_stamped_messages += updated?.length || 0;

    // Mirror onto conversations.
    await supabase
      .from("conversations")
      .update({
        [match.entityColumn]: match.personId,
        link_method: `tier1:${match.linkMethod}`,
      })
      .or(`external_conversation_id.eq.${externalConversationId},unipile_chat_id.eq.${externalConversationId}`)
      .is(match.entityColumn, null);
  }
}

function emptyCounts(): ResolveCounts {
  return { scanned: 0, resolved_existing: 0, back_stamped_messages: 0, unresolved: 0, errors: 0 };
}

function mergeCounts(into: ResolveCounts, from: ResolveCounts) {
  into.scanned += from.scanned;
  into.resolved_existing += from.resolved_existing;
  into.back_stamped_messages += from.back_stamped_messages;
  into.unresolved += from.unresolved;
  into.errors += from.errors;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
