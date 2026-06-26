import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/interview-calendar-sync
 *
 * Drops a NON-BLOCKING interview marker on Outlook calendars via Microsoft
 * Graph (app-only client_credentials — same path as create-outlook-event.ts).
 * The event is a zero-duration marker (start == end at the scheduled time)
 * with showAs:'free' + reminders off, so it's visible to everyone it lands on
 * but blocks no one's availability.
 *
 * Target calendars: the interview owner's mailbox + ALWAYS chris.sullivan@…
 * (deduped). Per-mailbox event ids are stored on interviews.calendar_event_ids
 * ([{email,id}]) so reschedules PATCH and cancels DELETE the same events.
 *
 * Body: { interview_id: string, action?: 'upsert' | 'delete' }
 *   - upsert (default): create/update the marker (or delete it if the
 *     interview has no scheduled_at).
 *   - delete: remove the marker from every calendar (used on cancel).
 */

const CHRIS_EMAIL = "chris.sullivan@emeraldrecruit.com";

async function getGraphToken(supabase: any): Promise<string> {
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["MICROSOFT_GRAPH_CLIENT_ID", "MICROSOFT_GRAPH_CLIENT_SECRET", "MICROSOFT_GRAPH_TENANT_ID"]);
  const m = new Map((settings ?? []).map((s: any) => [s.key, s.value]));
  const clientId = m.get("MICROSOFT_GRAPH_CLIENT_ID");
  const clientSecret = m.get("MICROSOFT_GRAPH_CLIENT_SECRET");
  const tenantId = m.get("MICROSOFT_GRAPH_TENANT_ID");
  if (!clientId || !clientSecret || !tenantId) throw new Error("Microsoft Graph credentials missing in app_settings");
  const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) throw new Error(`Microsoft token error: ${await r.text()}`);
  return (await r.json()).access_token;
}

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

  const { interview_id, action = "upsert" } = req.body || {};
  if (!interview_id) return res.status(400).json({ error: "interview_id required" });

  try {
    const { data: iv, error: ivErr } = await supabase
      .from("interviews")
      .select(`id, scheduled_at, end_at, round, interview_type, location, meeting_link,
        owner_id, calendar_event_ids, interviewer_name,
        candidate:people!candidate_id(full_name, first_name, last_name),
        jobs(title, company_name)`)
      .eq("id", interview_id)
      .maybeSingle();
    if (ivErr) throw ivErr;
    if (!iv) return res.status(404).json({ error: "Interview not found" });

    // Owner mailbox + always Chris, deduped.
    let ownerEmail: string | null = null;
    if ((iv as any).owner_id) {
      const { data: prof } = await supabase.from("profiles").select("email").eq("id", (iv as any).owner_id).maybeSingle();
      ownerEmail = (prof as any)?.email ?? null;
    }
    const ownerLower = ownerEmail ? ownerEmail.toLowerCase() : null;
    const targets = Array.from(new Set([ownerLower, CHRIS_EMAIL].filter(Boolean) as string[]));

    const existing: Array<{ email: string; id: string }> =
      Array.isArray((iv as any).calendar_event_ids) ? (iv as any).calendar_event_ids : [];
    const accessToken = await getGraphToken(supabase);

    const delEvent = async (email: string, id: string) => {
      await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/events/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => {});
    };

    const scheduledAt = (iv as any).scheduled_at;

    // Cancel / unschedule → remove every marker.
    if (action === "delete" || !scheduledAt) {
      for (const e of existing) await delEvent(e.email, e.id);
      await supabase.from("interviews").update({
        calendar_event_ids: [],
        calendar_event_id: null,
        calendar_synced_at: new Date().toISOString(),
      }).eq("id", interview_id);
      return res.status(200).json({ deleted: existing.length });
    }

    // Build the zero-duration, non-blocking marker.
    const cand: any = (iv as any).candidate;
    const candName = cand?.full_name || `${cand?.first_name ?? ""} ${cand?.last_name ?? ""}`.trim() || "Candidate";
    const job: any = (iv as any).jobs;
    const roleLine = [job?.title, job?.company_name].filter(Boolean).join(" @ ");
    const subject = `Interview: ${candName}${roleLine ? ` — ${roleLine}` : ""}`;
    const startMs = new Date(scheduledAt).getTime();
    const startIso = new Date(startMs).toISOString();
    // Near-zero-duration marker by default (1 min — Outlook rejects equal
    // start/end). showAs:'free' below is what actually keeps it from blocking
    // anyone's time. Honor an explicit end if one was set, but never let it be
    // at/before the start (mis-entered end dates would otherwise 400 on Graph).
    let endIso = (iv as any).end_at
      ? new Date((iv as any).end_at).toISOString()
      : new Date(startMs + 60_000).toISOString();
    if (new Date(endIso).getTime() <= startMs) endIso = new Date(startMs + 60_000).toISOString();
    const descLines = [
      roleLine ? `Role: ${roleLine}` : null,
      (iv as any).round ? `Round: ${(iv as any).round}` : null,
      (iv as any).interview_type ? `Type: ${(iv as any).interview_type}` : null,
      (iv as any).interviewer_name ? `Interviewer: ${(iv as any).interviewer_name}` : null,
      (iv as any).location ? `Location: ${(iv as any).location}` : null,
      (iv as any).meeting_link ? `Link: ${(iv as any).meeting_link}` : null,
      `(Non-blocking marker — manage in Sully Recruit → Interviews.)`,
    ].filter(Boolean);
    const eventBody: Record<string, any> = {
      subject,
      body: { contentType: "HTML", content: descLines.join("<br>") },
      start: { dateTime: startIso, timeZone: "UTC" },
      end: { dateTime: endIso, timeZone: "UTC" },
      showAs: "free", // visible but does NOT block availability
      isReminderOn: false,
      categories: ["Interview"],
    };
    if ((iv as any).location) eventBody.location = { displayName: (iv as any).location };

    const synced: Array<{ email: string; id: string }> = [];
    for (const email of targets) {
      const prior = existing.find((e) => e.email === email);
      let done = false;
      if (prior) {
        const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/events/${prior.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventBody),
        });
        if (r.ok) { synced.push({ email, id: prior.id }); done = true; }
        // PATCH failed (likely deleted in Outlook) → fall through to create.
      }
      if (!done) {
        const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/events`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventBody),
        });
        if (r.ok) {
          const ev = await r.json();
          synced.push({ email, id: ev.id });
        } else {
          // Don't fail the whole sync because one mailbox rejected.
          console.error(`interview-calendar-sync: create failed for ${email}: ${(await r.text()).slice(0, 200)}`);
        }
      }
    }

    // Remove markers from any mailbox no longer targeted (e.g. owner changed).
    for (const e of existing) {
      if (!targets.includes(e.email)) await delEvent(e.email, e.id);
    }

    const primary = (ownerLower && synced.find((s) => s.email === ownerLower)) || synced[0] || null;
    await supabase.from("interviews").update({
      calendar_event_ids: synced,
      calendar_event_id: primary?.id ?? null,
      calendar_synced_at: new Date().toISOString(),
    }).eq("id", interview_id);

    return res.status(200).json({ synced });
  } catch (err: any) {
    console.error("interview-calendar-sync error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
