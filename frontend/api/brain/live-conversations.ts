import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";
import { unipileFetch } from "../../src/server-lib/unipile-v2.js";

/**
 * POST /api/brain/live-conversations
 *
 * Fetch a person's most recent LinkedIn conversations LIVE from Unipile
 * instead of from the DB. Use this when the DB-archived /person-comms
 * feels stale or when the chat hasn't been picked up by sync yet —
 * Unipile sees newer messages here than we may have indexed.
 *
 * Routing reality check (May 2026): per claude/CLAUDE.md the Unipile
 * Methods API only works on v1 for our tenant — the v2 host returns 403
 * on Recruiter scope. So this endpoint hits v1 via the shared
 * `unipileFetch` helper (which despite its filename routes to v1).
 *
 * Read-only: we do NOT insert into the messages table from here. The
 * fetch-entity-history Inngest job is the one and only message writer.
 *
 * Body: { person_id: string, limit?: number (default 8 chats, max 20) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const personId = String(req.body?.person_id ?? "").trim();
  if (!personId) return res.status(400).json({ error: "person_id required" });

  const chatLimit = Math.min(Math.max(Number(req.body?.limit) || 8, 1), 20);
  const msgsPerChat = 20;

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const { data: person, error: pErr } = await supabase
      .from("people")
      .select("id, full_name, type, linkedin_url, unipile_provider_id, unipile_classic_id, unipile_recruiter_id, primary_email, work_email, personal_email")
      .eq("id", personId)
      .maybeSingle();
    if (pErr) return res.status(500).json({ error: pErr.message });
    if (!person) return res.status(404).json({ error: "person not found", person_id: personId });

    // Pick channel mappings from either candidates or contacts table —
    // the unified people table doesn't store the external_conversation_id
    // directly; that lives in the per-channel cache tables.
    const channelTable = person.type === "client" ? "contact_channels" : "candidate_channels";
    const fkColumn = person.type === "client" ? "contact_id" : "candidate_id";
    const { data: cachedChannels } = await supabase
      .from(channelTable)
      .select("channel, provider_id, external_conversation_id, unipile_id")
      .eq(fkColumn, personId);

    const { data: liAccounts } = await supabase
      .from("integration_accounts")
      .select("id, account_label, account_type, unipile_account_id")
      .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);

    if (!liAccounts?.length) {
      return res.status(200).json({
        person_id: personId,
        person_name: person.full_name,
        conversations: [],
        warning: "No active LinkedIn Unipile accounts. Reconnect under Settings → Integrations.",
      });
    }

    const conversations: Array<Record<string, unknown>> = [];
    const errors: Array<{ account: string; error: string }> = [];

    for (const acct of liAccounts) {
      const bucket =
        acct.account_type === "linkedin_recruiter" ? "linkedin_recruiter" : "linkedin";

      // Strategy: prefer the cached external_conversation_id when we
      // have one — that's the chat we've already linked to this person.
      // Fall back to filtering Unipile's chat list by the attendee's
      // provider_id when we don't.
      const knownChat = cachedChannels?.find(
        (c) => c.channel === bucket && c.external_conversation_id,
      );

      const chatIds: string[] = [];
      if (knownChat?.external_conversation_id) {
        chatIds.push(knownChat.external_conversation_id);
      } else {
        // Try Unipile's list-chats endpoint scoped to this attendee.
        // v1 accepts `attendee_id` as a query param to filter chats
        // involving a specific LinkedIn provider_id. If our person has
        // no provider_id resolved yet there's nothing useful to ask
        // Unipile for.
        const providerId =
          (bucket === "linkedin_recruiter" ? person.unipile_recruiter_id : person.unipile_classic_id)
          || person.unipile_provider_id;
        if (!providerId) continue;
        try {
          const list: any = await unipileFetch(
            supabase,
            acct.unipile_account_id,
            "chats",
            { method: "GET", query: { limit: chatLimit, attendee_id: providerId } },
          );
          const items = list?.items ?? list ?? [];
          for (const c of items.slice(0, chatLimit)) {
            if (c?.id) chatIds.push(c.id);
          }
        } catch (err: any) {
          errors.push({ account: acct.account_label ?? acct.id, error: err?.message?.slice(0, 200) ?? "unknown" });
          continue;
        }
      }

      for (const chatId of chatIds.slice(0, chatLimit)) {
        try {
          const msgs: any = await unipileFetch(
            supabase,
            acct.unipile_account_id,
            `chats/${encodeURIComponent(chatId)}/messages`,
            { method: "GET", query: { limit: msgsPerChat } },
          );
          const items = msgs?.items ?? msgs ?? [];
          conversations.push({
            channel: bucket,
            account: acct.account_label,
            chat_id: chatId,
            message_count: items.length,
            messages: items.map((m: any) => ({
              id: m.id ?? null,
              direction: m.is_sender ? "outbound" : "inbound",
              body: typeof m.text === "string" ? m.text.slice(0, 1500) : (m.body ?? null),
              sender_name: m.sender_name ?? null,
              timestamp: m.timestamp ?? m.created_at ?? null,
            })),
          });
        } catch (err: any) {
          errors.push({ account: acct.account_label ?? acct.id, error: err?.message?.slice(0, 200) ?? "unknown" });
        }
      }
    }

    // Sort conversations by their most-recent message timestamp.
    conversations.sort((a, b) => {
      const aMsgs = (a as any).messages as { timestamp?: string }[] | undefined;
      const bMsgs = (b as any).messages as { timestamp?: string }[] | undefined;
      const at = new Date(aMsgs?.[0]?.timestamp ?? 0).getTime();
      const bt = new Date(bMsgs?.[0]?.timestamp ?? 0).getTime();
      return bt - at;
    });

    return res.status(200).json({
      person_id: personId,
      person_name: person.full_name,
      source: "unipile v1 (live)",
      conversation_count: conversations.length,
      conversations,
      errors: errors.length ? errors : undefined,
    });
  } catch (err: any) {
    console.error("brain/live-conversations error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
