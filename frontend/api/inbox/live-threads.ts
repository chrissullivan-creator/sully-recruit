import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/inbox/live-threads?channel=email|linkedin|recruiter&limit=100&cursor=...
 *
 * Proxies Unipile v1 to fetch the most recent threads on the requested
 * channel across all of the user's connected integration_accounts. Used
 * by the inbox's "Other" tab to render unknown senders (those we don't
 * persist under the Phase 5 storage rule).
 *
 * Returns normalized threads in the same shape as `inbox_threads` rows
 * so the frontend can merge them with persisted Supabase data:
 *
 *   {
 *     items: [{
 *       id, channel, subject, sender_name, sender_address,
 *       last_message_at, last_message_preview,
 *       external_conversation_id, account_id, source: 'live',
 *     }],
 *     cursors: { [accountId]: nextCursor | null }
 *   }
 *
 * Auth: Supabase JWT. The user's owner_user_id scopes which integration
 * accounts we look at; admins see all team accounts.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const channelParam = (req.query.channel as string) || "linkedin";
  const limitParam = Math.min(parseInt((req.query.limit as string) || "100", 10) || 100, 100);
  const cursorParam = (req.query.cursor as string) || undefined;

  // Map UI channel to integration_accounts.account_type filter.
  const accountTypeFilter = ((): string[] => {
    if (channelParam === "email") return ["email"];
    if (channelParam === "linkedin") return ["linkedin", "linkedin_classic"];
    if (channelParam === "recruiter") return ["linkedin_recruiter"];
    return ["linkedin", "linkedin_classic"];
  })();

  const [{ data: baseRow }, { data: keyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
  ]);
  const v2Base = (baseRow?.value || "").replace(/\/+$/, "") || "https://api.unipile.com/v2";
  const apiKey = keyRow?.value;
  if (!apiKey) return res.status(500).json({ error: "Unipile v2 config missing" });

  // Pick integration accounts. Default scope: the calling user's own
  // accounts. (Team-wide view is delegated to the existing inbox UI
  // admin dropdown — keep this endpoint simple.)
  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, unipile_account_id, account_type, email_address, owner_user_id, metadata")
    .in("account_type", accountTypeFilter)
    .eq("owner_user_id", user.id)
    .eq("is_active", true)
    .not("unipile_account_id", "is", null);

  if (!accounts || accounts.length === 0) {
    return res.status(200).json({ items: [], cursors: {} });
  }

  type ThreadItem = {
    id: string;
    channel: string;
    subject: string | null;
    sender_name: string | null;
    sender_address: string | null;
    last_message_at: string | null;
    last_message_preview: string | null;
    external_conversation_id: string;
    integration_account_id: string;
    account_id: string | null;
    source: "live";
  };

  const cursors: Record<string, string | null> = {};
  const items: ThreadItem[] = [];

  // For each account, fetch the most recent threads in parallel.
  await Promise.all(
    accounts.map(async (acct: any) => {
      // Prefer the v2 account ID; fall back to the v1 ID if v2 isn't set.
      const accountId = (acct.metadata?.unipile_account_id_v2 || acct.unipile_account_id) as string;
      const isEmail = acct.account_type === "email";

      // v2: account_id in path, not query param.
      const qs = new URLSearchParams({ limit: String(limitParam) });
      if (cursorParam) qs.set("cursor", cursorParam);

      // /chats for LinkedIn classic, /linkedin/recruiter/chats for Recruiter, /emails for email.
      const path = isEmail
        ? `/${accountId}/emails`
        : acct.account_type === "linkedin_recruiter"
          ? `/${accountId}/linkedin/recruiter/chats`
          : `/${accountId}/chats`;
      const url = `${v2Base}${path}?${qs.toString()}`;

      try {
        const r = await fetch(url, {
          headers: {
            "X-API-KEY": apiKey,
            Accept: "application/json",
          },
        });
        if (!r.ok) {
          console.error("Unipile fetch failed", { account_id: accountId, status: r.status });
          return;
        }
        const body: any = await r.json();
        cursors[acct.id] = body?.cursor ?? null;
        const rows: any[] = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];

        for (const row of rows) {
          // Normalize the very-different shapes between /chats and /emails.
          if (isEmail) {
            items.push({
              id: `live:${acct.id}:${row.id}`,
              channel: "email",
              subject: row.subject ?? null,
              sender_name: row.from_attendee?.display_name ?? row.from?.name ?? null,
              sender_address: row.from_attendee?.identifier ?? row.from?.identifier ?? null,
              last_message_at: row.date ?? row.timestamp ?? null,
              last_message_preview: (row.body_plain ?? row.body ?? "").substring(0, 200),
              external_conversation_id: row.thread_id ?? row.id,
              integration_account_id: acct.id,
              account_id: accountId,
              source: "live",
            });
          } else {
            items.push({
              id: `live:${acct.id}:${row.id}`,
              channel: acct.account_type === "linkedin_recruiter" ? "linkedin_recruiter" : "linkedin",
              subject: row.subject ?? null,
              sender_name: row.attendee_provider_id_to_attendee?.[0]?.name ?? null,
              sender_address: row.attendee_provider_id_to_attendee?.[0]?.provider_id ?? null,
              last_message_at: row.timestamp ?? row.last_message_at ?? null,
              last_message_preview: (row.lastMessage?.text ?? row.preview ?? "").substring(0, 200),
              external_conversation_id: row.id,
              integration_account_id: acct.id,
              account_id: accountId,
              source: "live",
            });
          }
        }
      } catch (err: any) {
        console.error("Live-threads fetch error", { account_id: accountId, error: err?.message });
      }
    }),
  );

  // Sort by last_message_at desc.
  items.sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });

  // Dedupe against persisted conversations so we don't show the same
  // thread twice in the Other tab. A thread is "persisted" if a row in
  // public.conversations has the same external_conversation_id +
  // integration_account_id.
  if (items.length > 0) {
    const externalIds = items.map((i) => i.external_conversation_id);
    const { data: persisted } = await supabase
      .from("conversations")
      .select("external_conversation_id, integration_account_id")
      .in("external_conversation_id", externalIds);

    const persistedSet = new Set(
      (persisted ?? []).map(
        (p: any) => `${p.external_conversation_id}::${p.integration_account_id ?? ""}`,
      ),
    );
    const filtered = items.filter(
      (i) => !persistedSet.has(`${i.external_conversation_id}::${i.integration_account_id ?? ""}`),
    );

    res.setHeader("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
    return res.status(200).json({ items: filtered, cursors });
  }

  res.setHeader("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
  return res.status(200).json({ items: [], cursors: {} });
}
