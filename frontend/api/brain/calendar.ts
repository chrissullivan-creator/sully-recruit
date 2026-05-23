import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/calendar
 *
 * Outlook + Sully Recruit calendar lookups. Calendar events live in `tasks`
 * with `start_time` set (Outlook syncs into this table). Optional filters:
 *   - person_id   only events with this person as attendee
 *   - from_date   ISO string, default = 30 days ago
 *   - to_date     ISO string, default = 60 days from now
 *   - query       free-text match on title/description
 *   - limit       default 25, max 100
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const personId = typeof req.body?.person_id === "string" ? req.body.person_id.trim() : "";
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const limit = Math.min(Math.max(Number(req.body?.limit) || 25, 1), 100);

  const fromDate = parseDate(req.body?.from_date) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = parseDate(req.body?.to_date) ?? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  let taskIdsFilter: string[] | null = null;
  if (personId) {
    const { data: attRows, error: attErr } = await supabase
      .from("meeting_attendees")
      .select("task_id")
      .eq("entity_id", personId);
    if (attErr) return res.status(500).json({ error: `attendees: ${attErr.message}` });
    taskIdsFilter = (attRows ?? []).map((r: any) => r.task_id).filter(Boolean);
    if (taskIdsFilter.length === 0) {
      return res.status(200).json({ person_id: personId, count: 0, events: [] });
    }
  }

  let q = supabase
    .from("tasks")
    .select(
      "id, title, description, status, task_type, start_time, end_time, timezone, location, meeting_url, meeting_provider, related_to_type, related_to_id, created_by, assigned_to, calendar_event_id, created_at",
    )
    .not("start_time", "is", null)
    .gte("start_time", fromDate.toISOString())
    .lte("start_time", toDate.toISOString())
    .order("start_time", { ascending: true })
    .limit(limit);

  if (taskIdsFilter) q = q.in("id", taskIdsFilter);

  if (query) {
    const tokens = query.split(/\s+/).filter((t) => t.length >= 2).slice(0, 3);
    const orFilter = tokens
      .flatMap((t) => [`title.ilike.%${t}%`, `description.ilike.%${t}%`, `location.ilike.%${t}%`])
      .join(",");
    q = q.or(orFilter);
  }

  const { data: events, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const eventIds = (events ?? []).map((e: any) => e.id);
  let attendeeRows: any[] = [];
  if (eventIds.length > 0) {
    const { data } = await supabase
      .from("meeting_attendees")
      .select("task_id, entity_type, entity_id")
      .in("task_id", eventIds);
    attendeeRows = data ?? [];
  }

  const attByTask = new Map<string, any[]>();
  for (const a of attendeeRows) {
    const arr = attByTask.get(a.task_id) ?? [];
    arr.push({ entity_type: a.entity_type, entity_id: a.entity_id });
    attByTask.set(a.task_id, arr);
  }

  return res.status(200).json({
    person_id: personId || null,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    count: events?.length ?? 0,
    events: (events ?? []).map((e: any) => ({
      id: e.id,
      title: e.title,
      description: typeof e.description === "string" ? e.description.slice(0, 1000) : null,
      task_type: e.task_type,
      status: e.status,
      start_time: e.start_time,
      end_time: e.end_time,
      timezone: e.timezone,
      location: e.location,
      meeting_url: e.meeting_url,
      meeting_provider: e.meeting_provider,
      related_to_type: e.related_to_type,
      related_to_id: e.related_to_id,
      attendees: attByTask.get(e.id) ?? [],
    })),
  });
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
