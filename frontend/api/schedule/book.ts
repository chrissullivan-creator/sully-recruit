import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import {
  getMicrosoftAccessToken,
  getCalendarFreeBusy,
  createCalendarEvent,
} from "../../src/server-lib/microsoft-graph.js";
import { validateSlot } from "../../src/server-lib/scheduling.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/schedule/book
 *
 * PUBLIC (no auth). Books a slot on an active scheduling link.
 *
 * Body: { slug, start_at, invitee_name, invitee_email, invitee_phone?,
 *         notes?, person_id? }
 *
 * Steps:
 *   1. Look up the active link (service role, bypasses RLS).
 *   2. RE-VALIDATE the requested slot against live free/busy + existing
 *      bookings to prevent double-booking.
 *   3. Create the Outlook event on the owner's calendar. Subject is
 *      "{title} with {invitee_name}"; the invitee is added as an attendee so
 *      Graph emails them the invite. Teams meeting attached when
 *      meeting_type === 'teams'.
 *   4. Insert a scheduling_bookings row (linking the person if provided).
 *
 * Returns: { ok, start_at, end_at, meeting_type, join_url? }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const {
    slug,
    start_at,
    invitee_name,
    invitee_email,
    invitee_phone = null,
    notes = null,
    person_id = null,
  } = req.body || {};

  if (!slug || !start_at || !invitee_name || !invitee_email) {
    return res
      .status(400)
      .json({ error: "slug, start_at, invitee_name, and invitee_email are required" });
  }
  if (!EMAIL_RE.test(String(invitee_email).trim())) {
    return res.status(400).json({ error: "invitee_email is not a valid email address" });
  }
  const startUtc = new Date(String(start_at));
  if (Number.isNaN(startUtc.getTime())) {
    return res.status(400).json({ error: "start_at must be a valid ISO datetime" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { data: link, error: linkErr } = await supabase
      .from("scheduling_links")
      .select(
        "id, owner_user_id, integration_account_id, slug, title, duration_min, meeting_type, location, timezone, working_hours, buffer_min, min_notice_hours, max_days_out, max_per_day, max_business_days, active",
      )
      .eq("slug", String(slug).trim())
      .maybeSingle();

    if (linkErr) throw linkErr;
    if (!link || !link.active) {
      return res.status(404).json({ error: "This scheduling link is not available." });
    }

    // Resolve the mailbox to read/write.
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

    const linkConfig = {
      duration_min: link.duration_min || 30,
      timezone: link.timezone || "America/New_York",
      working_hours: (link.working_hours as any) || {},
      buffer_min: link.buffer_min || 0,
      min_notice_hours: link.min_notice_hours || 0,
      max_days_out: link.max_days_out || 21,
      max_business_days: link.max_business_days ?? null,
    };

    // ── Re-validate against live free/busy + existing bookings ───────────
    const accessToken = await getMicrosoftAccessToken();
    const windowStart = new Date(startUtc.getTime() - 2 * 3600_000);
    const windowEnd = new Date(startUtc.getTime() + (linkConfig.duration_min + 120) * 60000);

    const busy = await getCalendarFreeBusy(
      accessToken,
      mailboxEmail,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      linkConfig.duration_min,
    );

    const { data: existingBookings } = await supabase
      .from("scheduling_bookings")
      .select("start_at, end_at")
      .eq("link_id", link.id)
      .eq("status", "confirmed")
      .gte("start_at", windowStart.toISOString())
      .lte("start_at", windowEnd.toISOString());

    const validation = validateSlot(
      linkConfig,
      startUtc,
      busy,
      existingBookings || [],
      new Date(),
    );
    if (!validation.ok) {
      return res.status(409).json({ error: validation.reason });
    }
    const endIso = validation.endIso;

    // ── Enforce the per-day booking cap ──────────────────────────────────
    if (link.max_per_day) {
      const dayFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: linkConfig.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const dayStr = dayFmt.format(startUtc);
      const dayWindowStart = new Date(startUtc.getTime() - 26 * 3600_000).toISOString();
      const dayWindowEnd = new Date(startUtc.getTime() + 26 * 3600_000).toISOString();
      const { data: dayBookings } = await supabase
        .from("scheduling_bookings")
        .select("start_at")
        .eq("link_id", link.id)
        .eq("status", "confirmed")
        .gte("start_at", dayWindowStart)
        .lte("start_at", dayWindowEnd);
      const sameDay = (dayBookings || []).filter(
        (b) => dayFmt.format(new Date(b.start_at)) === dayStr,
      ).length;
      if (sameDay >= link.max_per_day) {
        return res
          .status(409)
          .json({ error: "That day is fully booked — please pick another day." });
      }
    }

    // ── Resolve the optional person link ─────────────────────────────────
    // The booking table keeps candidate_id + contact_id separate (mirroring
    // the inbox surfaces); pick the column from the person's unified type.
    let candidateId: string | null = null;
    let contactId: string | null = null;
    if (person_id) {
      const { data: person } = await supabase
        .from("people")
        .select("id, type")
        .eq("id", person_id)
        .maybeSingle();
      if (person?.id) {
        if (person.type === "client") contactId = person.id;
        else candidateId = person.id;
      }
    }

    // ── Create the Outlook event ─────────────────────────────────────────
    const inviteeName = String(invitee_name).trim();
    const inviteeEmail = String(invitee_email).trim();
    const subject = `${link.title || "Meeting"} with ${inviteeName}`;
    const isTeams = link.meeting_type === "teams";

    const descriptionLines = [
      `Booked via your scheduling link (${link.slug}).`,
      invitee_phone ? `Phone: ${String(invitee_phone).trim()}` : null,
      notes ? `Notes: ${String(notes).trim()}` : null,
    ].filter(Boolean);

    const event = await createCalendarEvent(accessToken, mailboxEmail, {
      subject,
      startIso: startUtc.toISOString(),
      endIso,
      description: descriptionLines.join("<br/>"),
      location: isTeams ? undefined : link.location || undefined,
      online: isTeams,
      attendeeEmail: inviteeEmail,
      attendeeName: inviteeName,
    });

    // ── Persist the booking ──────────────────────────────────────────────
    const { error: insertErr } = await supabase.from("scheduling_bookings").insert({
      link_id: link.id,
      candidate_id: candidateId,
      contact_id: contactId,
      invitee_name: inviteeName,
      invitee_email: inviteeEmail,
      invitee_phone: invitee_phone ? String(invitee_phone).trim() : null,
      start_at: startUtc.toISOString(),
      end_at: endIso,
      status: "confirmed",
      outlook_event_id: event.id || null,
      notes: notes ? String(notes).trim() : null,
    } as any);

    if (insertErr) {
      // The event already landed on the calendar; surface a soft error so the
      // invitee still sees confirmation rather than a hard failure.
      console.error("schedule/book insert error (event was created):", insertErr.message);
    }

    return res.status(200).json({
      ok: true,
      start_at: startUtc.toISOString(),
      end_at: endIso,
      meeting_type: link.meeting_type,
      join_url: event.joinUrl || null,
    });
  } catch (err: any) {
    console.error("schedule/book error:", err.message);
    return res.status(500).json({ error: err.message || "Failed to book" });
  }
}
