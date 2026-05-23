import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/person-comms
 *
 * "What did they last say?" — pulls the most recent N messages (email +
 * LinkedIn + SMS) AND call notes for a person, merged + sorted by time.
 * Each row includes the actual body / AI summary so the GPT can quote
 * verbatim instead of hallucinating.
 *
 * Body: { person_id: string, limit?: number (default 10, max 30) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const personId = String(req.body?.person_id ?? "").trim();
  if (!personId) return res.status(400).json({ error: "person_id required" });

  const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 30);

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const personFilter = `candidate_id.eq.${personId},contact_id.eq.${personId}`;

  const [msgRes, callRes, convRes] = await Promise.all([
    supabase
      .from("messages")
      .select(
        "id, channel, direction, subject, body, sender_name, sender_address, recipient_address, sent_at, received_at, ai_tag_summary, ai_tags",
      )
      .or(personFilter)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(limit * 2),
    supabase
      .from("ai_call_notes")
      .select(
        "id, call_direction, call_started_at, call_duration_seconds, ai_summary, ai_action_items, extracted_notes, transcript",
      )
      .or(personFilter)
      .order("call_started_at", { ascending: false, nullsFirst: false })
      .limit(limit),
    supabase
      .from("call_logs")
      .select("id, direction, started_at, duration_seconds, summary, notes, audio_url")
      .or(personFilter)
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(limit),
  ]);

  if (msgRes.error) return res.status(500).json({ error: `messages: ${msgRes.error.message}` });
  if (callRes.error) return res.status(500).json({ error: `ai_call_notes: ${callRes.error.message}` });
  if (convRes.error) return res.status(500).json({ error: `call_logs: ${convRes.error.message}` });

  const messages = ((msgRes.data as any[]) ?? []).map((m) => ({
    kind: "message" as const,
    channel: m.channel ?? "unknown",
    direction: m.direction ?? null,
    subject: m.subject ?? null,
    from: m.sender_name || m.sender_address || null,
    to: m.recipient_address ?? null,
    body: stripHtml(m.body ?? "").slice(0, 1500),
    ai_summary: m.ai_tag_summary ?? null,
    ai_tags: m.ai_tags ?? null,
    timestamp: m.sent_at ?? m.received_at ?? null,
    id: m.id,
  }));

  const aiCalls = ((callRes.data as any[]) ?? []).map((c) => ({
    kind: "call" as const,
    channel: "phone",
    direction: c.call_direction ?? null,
    duration_seconds: c.call_duration_seconds ?? null,
    summary: (c.ai_summary ?? "").slice(0, 1500),
    action_items: c.ai_action_items ?? null,
    extracted_notes: (c.extracted_notes ?? "").slice(0, 800),
    transcript_excerpt: (c.transcript ?? "").slice(0, 1200),
    timestamp: c.call_started_at,
    id: c.id,
  }));

  // Manual call_logs (recruiter typed a note, no AI summary)
  const aiIds = new Set(aiCalls.map((c) => c.id));
  const manualCalls = ((convRes.data as any[]) ?? [])
    .filter((c) => !aiIds.has(c.id))
    .map((c) => ({
      kind: "call" as const,
      channel: "phone",
      direction: c.direction ?? null,
      duration_seconds: c.duration_seconds ?? null,
      summary: (c.summary ?? c.notes ?? "").slice(0, 1200),
      audio_url: c.audio_url ?? null,
      timestamp: c.started_at,
      id: c.id,
    }));

  const merged = [...messages, ...aiCalls, ...manualCalls]
    .sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime())
    .slice(0, limit);

  const lastInbound = messages.find((m) => m.direction === "inbound" || m.direction === "received");
  const lastOutbound = messages.find((m) => m.direction === "outbound" || m.direction === "sent");

  return res.status(200).json({
    person_id: personId,
    count: merged.length,
    last_inbound: lastInbound ?? null,
    last_outbound: lastOutbound ?? null,
    items: merged,
  });
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
