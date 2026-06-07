import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { getMicrosoftAccessToken, getCalendarFreeBusy } from "../../src/server-lib/microsoft-graph.js";
import { computeOpenSlots } from "../../src/server-lib/scheduling.js";

/**
 * GET /api/schedule/slots?slug=<slug>&from=<ISO>&to=<ISO>
 *
 * PUBLIC (no auth). Computes open booking slots for an active scheduling
 * link, honoring its timezone, working hours, notice/horizon, and buffer —
 * minus the owner's Outlook busy blocks (Graph getSchedule) and any existing
 * scheduling_bookings.
 *
 * `from` / `to` default to [now, now + max_days_out]. They're clamped to the
 * link's notice/horizon regardless.
 *
 * Returns: { slug, timezone, duration_min, meeting_type, days: [{ date,
 * slots: [{ start, end }] }] } with all instants in UTC ISO.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const slug = String(req.query.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "slug is required" });

  // Public endpoint → service role (bypasses RLS).
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { data: link, error: linkErr } = await supabase
      .from("scheduling_links")
      .select(
        "id, integration_account_id, slug, title, duration_min, meeting_type, location, timezone, working_hours, buffer_min, min_notice_hours, max_days_out, max_per_day, max_business_days, active",
      )
      .eq("slug", slug)
      .maybeSingle();

    if (linkErr) throw linkErr;
    if (!link || !link.active) {
      return res.status(404).json({ error: "This scheduling link is not available." });
    }

    // Resolve the mailbox we read free/busy against.
    let mailboxEmail = "";
    if (link.integration_account_id) {
      const { data: acct } = await supabase
        .from("integration_accounts")
        .select("email_address")
        .eq("id", link.integration_account_id)
        .maybeSingle();
      mailboxEmail = (acct?.email_address || "").trim();
    }
    if (!mailboxEmail) {
      return res.status(409).json({ error: "This scheduling link has no calendar connected." });
    }

    // Window bounds.
    const now = new Date();
    const horizon = new Date(now.getTime() + (link.max_days_out || 21) * 86_400_000);
    const fromUtc = req.query.from ? new Date(String(req.query.from)) : now;
    const toUtc = req.query.to ? new Date(String(req.query.to)) : horizon;
    if (Number.isNaN(fromUtc.getTime()) || Number.isNaN(toUtc.getTime())) {
      return res.status(400).json({ error: "from/to must be valid ISO datetimes" });
    }

    // Effective bounds for the queries (clamped to notice/horizon).
    const earliest = new Date(now.getTime() + (link.min_notice_hours || 0) * 3600_000);
    const queryStart = new Date(Math.max(fromUtc.getTime(), earliest.getTime()) - 86_400_000);
    const queryEnd = new Date(Math.min(toUtc.getTime(), horizon.getTime()) + 86_400_000);

    // Owner's busy blocks from Outlook.
    let busy: { start: string; end: string }[] = [];
    try {
      const accessToken = await getMicrosoftAccessToken();
      busy = await getCalendarFreeBusy(
        accessToken,
        mailboxEmail,
        queryStart.toISOString(),
        queryEnd.toISOString(),
        link.duration_min || 30,
      );
    } catch (err: any) {
      // Fail closed on free/busy would block all bookings; instead surface a
      // clear error so the page can tell the invitee to try again.
      console.error("schedule/slots free/busy error:", err.message);
      return res.status(502).json({ error: "Couldn't read the calendar right now. Please try again shortly." });
    }

    // Existing bookings in the window (so two invitees can't grab the same
    // slot before the calendar sync catches up).
    const { data: existingBookings } = await supabase
      .from("scheduling_bookings")
      .select("start_at, end_at")
      .eq("link_id", link.id)
      .eq("status", "confirmed")
      .gte("start_at", queryStart.toISOString())
      .lte("start_at", queryEnd.toISOString());

    let days = computeOpenSlots(
      {
        duration_min: link.duration_min || 30,
        timezone: link.timezone || "America/New_York",
        working_hours: (link.working_hours as any) || {},
        buffer_min: link.buffer_min || 0,
        min_notice_hours: link.min_notice_hours || 0,
        max_days_out: link.max_days_out || 21,
        max_business_days: link.max_business_days ?? null,
      },
      fromUtc,
      toUtc,
      busy,
      existingBookings || [],
      now,
    );

    // Per-day cap: drop any day already at/over max_per_day confirmed bookings.
    if (link.max_per_day && (existingBookings?.length ?? 0) > 0) {
      const dayFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: link.timezone || "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const perDay: Record<string, number> = {};
      for (const b of existingBookings!) {
        const key = dayFmt.format(new Date(b.start_at));
        perDay[key] = (perDay[key] || 0) + 1;
      }
      days = days.filter((d) => (perDay[d.date] || 0) < (link.max_per_day as number));
    }

    return res.status(200).json({
      slug: link.slug,
      title: link.title || null,
      timezone: link.timezone,
      duration_min: link.duration_min,
      meeting_type: link.meeting_type,
      location: link.location || null,
      days,
    });
  } catch (err: any) {
    console.error("schedule/slots error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to load availability" });
  }
}
