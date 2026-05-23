import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/recent-activity
 *
 * What's been happening in the CRM lately. Returns a unified timeline:
 * recent messages, calls, send-out stage moves, notes, calendar events.
 *
 * Body: { person_id?: string, days?: number (default 7, max 90), limit?: number (default 30, max 100) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 90);
  const limit = Math.min(Math.max(Number(req.body?.limit) || 30, 1), 100);
  const personId = typeof req.body?.person_id === "string" ? req.body.person_id.trim() : "";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const personFilter = personId ? `candidate_id.eq.${personId},contact_id.eq.${personId}` : null;
  const perKindLimit = Math.min(Math.max(Math.ceil(limit / 4), 8), 40);

  const msgQ = supabase
    .from("messages")
    .select("id, channel, direction, subject, body, sender_name, sent_at, candidate_id, contact_id")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(perKindLimit);
  const callQ = supabase
    .from("ai_call_notes")
    .select("id, call_direction, call_started_at, ai_summary, candidate_id, contact_id")
    .gte("call_started_at", since)
    .order("call_started_at", { ascending: false })
    .limit(perKindLimit);
  const sendOutQ = supabase
    .from("send_outs")
    .select("id, stage, candidate_id, job_id, updated_at, sent_to_client_at, interview_at, offer_at, placed_at")
    .gte("updated_at", since)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(perKindLimit);
  const taskQ = supabase
    .from("tasks")
    .select("id, title, task_type, start_time, end_time, status, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(perKindLimit);

  const [msgRes, callRes, soRes, taskRes] = await Promise.all([
    personFilter ? msgQ.or(personFilter) : msgQ,
    personFilter ? callQ.or(personFilter) : callQ,
    personId ? sendOutQ.eq("candidate_id", personId) : sendOutQ,
    taskQ,
  ]);

  const timeline: any[] = [];

  for (const m of (msgRes.data as any[]) ?? []) {
    timeline.push({
      kind: "message",
      channel: m.channel,
      direction: m.direction,
      title: m.subject || `${m.sender_name ?? "Unknown"} → ${m.channel}`,
      excerpt: stripHtml(m.body ?? "").slice(0, 300),
      person_id: m.candidate_id || m.contact_id || null,
      timestamp: m.sent_at,
      id: m.id,
    });
  }
  for (const c of (callRes.data as any[]) ?? []) {
    timeline.push({
      kind: "call",
      direction: c.call_direction,
      title: `Call (${c.call_direction ?? "n/a"})`,
      excerpt: (c.ai_summary ?? "").slice(0, 300),
      person_id: c.candidate_id || c.contact_id || null,
      timestamp: c.call_started_at,
      id: c.id,
    });
  }
  for (const s of (soRes.data as any[]) ?? []) {
    timeline.push({
      kind: "send_out",
      title: `Send-out → ${s.stage}`,
      excerpt: null,
      person_id: s.candidate_id,
      job_id: s.job_id,
      stage: s.stage,
      timestamp: s.updated_at,
      id: s.id,
    });
  }
  for (const t of (taskRes.data as any[]) ?? []) {
    timeline.push({
      kind: t.task_type === "meeting" || t.start_time ? "meeting" : "task",
      title: t.title,
      excerpt: null,
      status: t.status,
      start_time: t.start_time,
      timestamp: t.created_at,
      id: t.id,
    });
  }

  timeline.sort(
    (a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime(),
  );

  return res.status(200).json({
    person_id: personId || null,
    days,
    since,
    count: Math.min(timeline.length, limit),
    items: timeline.slice(0, limit),
  });
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
