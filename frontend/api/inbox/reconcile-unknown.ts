import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { findPersonMatches } from "../lib/fuzzy-match-person.js";

/**
 * POST /api/inbox/reconcile-unknown
 *
 * Bulk version of the inbox "Add" flow: sweep unlinked conversations, fuzzy-
 * match each unknown sender (name + firm/title + any email/linkedin signal)
 * against the CRM, and propose linking them to an existing person.
 *
 *   mode: "scan"  (default) → dry run. Returns proposals; writes nothing.
 *   mode: "apply"          → links the conversations in `actions` to the
 *                            chosen person + backfills their messages.
 *
 * Scan body:  { mode?: "scan", limit?: number }
 * Apply body: { mode: "apply", actions: [{ conversation_id, person_id, type }] }
 * Auth: Supabase JWT.
 *
 * Bulk apply is LINK-ONLY (no profile overwrite) — overwriting with newest
 * needs a per-person LinkedIn lookup, which the per-thread wizard does. Creating
 * brand-new people in bulk is intentionally left to the per-thread flow too.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const mode = req.body?.mode === "apply" ? "apply" : "scan";

  try {
    if (mode === "apply") return await apply(supabase, req, res);
    return await scan(supabase, req, res);
  } catch (err: any) {
    console.error("reconcile-unknown error:", err?.message);
    return res.status(500).json({ error: err?.message || "Reconcile failed" });
  }
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const linkedinSlug = (s: string) =>
  /linkedin\.com\/in\//i.test(s) ? s : "";

async function scan(supabase: any, req: VercelRequest, res: VercelResponse) {
  const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200);
  // Optional channel filter (e.g. "linkedin_recruiter" for the InMail bulk-add).
  const channel = typeof req.body?.channel === "string" ? req.body.channel : "";
  // When true, also return unlinked rows that had NO confident match, carrying
  // the sender identity so the caller can offer "create new" (InMail bulk-add).
  const includeUnmatched = req.body?.include_unmatched === true;

  // Unlinked conversations (no CRM person on either side).
  let q = supabase
    .from("conversations")
    .select("id, channel, integration_account_id, last_message_at")
    .is("candidate_id", null)
    .is("contact_id", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (channel) q = q.eq("channel", channel);
  const { data: convs, error } = await q;
  if (error) throw error;

  const conversations = (convs as any[]) ?? [];
  if (!conversations.length) return res.status(200).json({ proposals: [] });

  // Latest inbound message per conversation → the unknown sender's identity.
  const proposals = await Promise.all(
    conversations.map(async (c) => {
      const { data: msg } = await supabase
        .from("messages")
        .select("sender_name, sender_address, channel")
        .eq("conversation_id", c.id)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const senderName = (msg?.sender_name ?? "").trim();
      const addr = (msg?.sender_address ?? "").trim();
      if (!senderName && !isEmail(addr)) {
        return { conversation_id: c.id, channel: c.channel, sender_name: senderName || null, sender_address: addr || null, best: null };
      }

      const matches = await findPersonMatches(supabase, {
        type: "candidate",
        name: senderName,
        email: isEmail(addr) ? addr : "",
        linkedin_url: linkedinSlug(addr),
        limit: 1,
      });
      const top = matches[0];
      // Only surface confident proposals — low-confidence name-only hits are
      // too noisy to auto-suggest in bulk.
      const best =
        top && (top.confidence === "high" || top.confidence === "medium")
          ? {
              id: top.id,
              type: top.type,
              name: top.full_name || `${top.first_name ?? ""} ${top.last_name ?? ""}`.trim(),
              title: top.title,
              company: top.company,
              confidence: top.confidence,
              matched_on: top.matched_on,
            }
          : null;

      return {
        conversation_id: c.id,
        channel: c.channel,
        sender_name: senderName || null,
        sender_address: addr || null,
        best,
      };
    }),
  );

  // Default (reconcile): only confident link proposals. With include_unmatched
  // (InMail bulk-add): also no-match rows that have a usable sender name, so the
  // caller can offer "create new" for them.
  const filtered = includeUnmatched
    ? proposals.filter((p) => p.best || p.sender_name)
    : proposals.filter((p) => p.best);

  return res.status(200).json({ scanned: conversations.length, proposals: filtered });
}

async function apply(supabase: any, req: VercelRequest, res: VercelResponse) {
  const actions: Array<{ conversation_id: string; person_id: string; type: string }> = Array.isArray(
    req.body?.actions,
  )
    ? req.body.actions
    : [];
  if (!actions.length) return res.status(400).json({ error: "No actions" });

  let linked = 0;
  const errors: string[] = [];
  for (const a of actions) {
    if (!a.conversation_id || !a.person_id) continue;
    const linkCol = a.type === "candidate" ? "candidate_id" : "contact_id";
    const { error: convErr } = await supabase
      .from("conversations")
      .update({ [linkCol]: a.person_id })
      .eq("id", a.conversation_id);
    if (convErr) {
      errors.push(`${a.conversation_id}: ${convErr.message}`);
      continue;
    }
    await supabase
      .from("messages")
      .update({ [linkCol]: a.person_id })
      .eq("conversation_id", a.conversation_id)
      .is(linkCol, null);
    linked += 1;
  }

  return res.status(200).json({ linked, errors });
}
