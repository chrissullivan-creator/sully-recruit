/**
 * Unipile v2 calendar fetch — parallel path to MS Graph
 * sync-outlook-events. Behind the USE_UNIPILE_CALENDAR app_settings
 * flag: when on, sync-outlook-events ALSO fetches via Unipile and
 * inserts into the same `tasks` table. Dedup happens on
 * tasks.external_id (Outlook event id is the same coming from
 * either provider) so Graph + Unipile running side-by-side is safe.
 *
 * Endpoint (v2, account_id in path):
 *   GET https://api.unipile.com/v2/{account_id}/calendars/events?start=…&end=…
 *
 * Field shapes vary by provider — defensive readers below.
 */
import { logger } from "./logger.js";
import { getAppSetting } from "./supabase.js";

export interface UnipileCalendarEvent {
  id: string;
  iCalUId?: string;
  subject: string;
  start_dt: string;
  end_dt: string;
  attendees: { email: string; name?: string }[];
  description: string;
  location: string;
  meetingUrl: string;
  timezone: string;
}

async function resolveBaseAndKey(supabase: any) {
  const [{ data: v2Row }, { data: v2KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
  ]);
  const v2Base = (v2Row?.value || "").replace(/\/+$/, "")
    || "https://api.unipile.com/v2";
  const apiKey = v2KeyRow?.value;
  if (!v2Base || !apiKey) throw new Error("Unipile config missing");
  return { v2Base, apiKey };
}

function toEvent(raw: any): UnipileCalendarEvent | null {
  const id = raw.id || raw.event_id || raw.iCalUId || raw.uid;
  if (!id) return null;
  const subject = raw.subject || raw.title || raw.summary || "";
  const start_dt =
    raw.start_dt || raw.start || raw.start_time || raw.start_date_time || raw.startTime || "";
  const end_dt =
    raw.end_dt || raw.end || raw.end_time || raw.end_date_time || raw.endTime || "";
  if (!subject || !start_dt) return null;
  const attendees = (raw.attendees || raw.participants || []).map((a: any) => ({
    email: (a.email || a.identifier || a.address || "").toLowerCase(),
    name: a.display_name || a.name || undefined,
  })).filter((a: any) => a.email);
  return {
    id: String(id),
    iCalUId: raw.iCalUId || raw.ical_uid || undefined,
    subject,
    start_dt: typeof start_dt === "string" ? start_dt : start_dt.dateTime || start_dt.date_time,
    end_dt: typeof end_dt === "string" ? end_dt : end_dt?.dateTime || end_dt?.date_time || "",
    attendees,
    description: raw.description || raw.body_preview || raw.body || "",
    location: raw.location?.name || raw.location?.display_name || raw.location || "",
    meetingUrl:
      raw.online_meeting?.join_url || raw.online_meeting_url || raw.meeting_url
      || raw.conference_url || "",
    timezone: raw.timezone || raw.start?.timeZone || "UTC",
  };
}

export async function fetchUnipileEventsForAccount(
  supabase: any,
  unipileAccountId: string,
  startISO: string,
  endISO: string,
): Promise<UnipileCalendarEvent[]> {
  const { v2Base, apiKey } = await resolveBaseAndKey(supabase);
  const qs = new URLSearchParams({
    start: startISO,
    end: endISO,
    limit: "100",
  });
  // v2: GET /v2/{account_id}/calendars/events?start=…&end=…
  const url = `${v2Base}/${encodeURIComponent(unipileAccountId)}/calendars/events?${qs.toString()}`;
  const resp = await fetch(url, {
    headers: { "X-API-KEY": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    logger.warn("Unipile calendar fetch failed", {
      url, status: resp.status, body: txt.slice(0, 300),
    });
    return [];
  }
  const data = await resp.json();
  const items = data.items ?? data.events ?? data.results ?? (Array.isArray(data) ? data : []);
  return items.map(toEvent).filter((x: any): x is UnipileCalendarEvent => !!x);
}

export async function shouldUseUnipileCalendar(): Promise<boolean> {
  try {
    const v = (await getAppSetting("USE_UNIPILE_CALENDAR")).toLowerCase();
    return v === "true" || v === "1" || v === "on" || v === "yes";
  } catch {
    return false;
  }
}
