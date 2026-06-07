import { logger } from "./logger.js";
import { getMicrosoftGraphCredentials } from "./supabase.js";
import { unipileSendEmail, shouldUseUnipileEmail } from "./unipile-email.js";
import { getSupabaseAdmin } from "./supabase.js";

/**
 * Shared Microsoft Graph helpers.
 * Used by send-channels.ts (email) and sync-outlook-contact.ts (contact sync).
 */

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — client credentials token
// ─────────────────────────────────────────────────────────────────────────────

export async function getMicrosoftAccessToken(): Promise<string> {
  const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft token error: ${errText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// FREE/BUSY + EVENTS — used by the self-scheduling endpoints
// (api/schedule/slots.ts + api/schedule/book.ts) to read a mailbox's busy
// blocks and write a confirmed booking onto its calendar.
// ─────────────────────────────────────────────────────────────────────────────

export interface BusyInterval {
  start: string; // ISO (UTC)
  end: string; // ISO (UTC)
}

/**
 * Read a mailbox's busy intervals over [startIso, endIso) via the Graph
 * `calendar/getSchedule` endpoint. Returns merged busy blocks in UTC ISO.
 * Treats tentative / busy / oof / workingElsewhere all as "busy" so we
 * never offer a slot the owner has anything on.
 *
 * `availabilityViewInterval` is the granularity (minutes) Graph buckets the
 * day into; we pass the slot duration so the coarse availabilityView string
 * lines up, but we rely on the precise `scheduleItems` for the actual math.
 */
export async function getCalendarFreeBusy(
  accessToken: string,
  mailboxEmail: string,
  startIso: string,
  endIso: string,
  intervalMinutes = 30,
): Promise<BusyInterval[]> {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/calendar/getSchedule`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        // getSchedule wants the timezone the response times come back in.
        Prefer: 'outlook.timezone="UTC"',
      },
      body: JSON.stringify({
        schedules: [mailboxEmail],
        startTime: { dateTime: startIso, timeZone: "UTC" },
        endTime: { dateTime: endIso, timeZone: "UTC" },
        availabilityViewInterval: Math.max(5, Math.min(intervalMinutes, 1440)),
      }),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph getSchedule error (${resp.status}): ${err.slice(0, 300)}`);
  }

  const data = (await resp.json()) as any;
  const schedule = (data.value || [])[0];
  const items: any[] = schedule?.scheduleItems || [];

  const busy: BusyInterval[] = [];
  for (const it of items) {
    // status: free | tentative | busy | oof | workingElsewhere | unknown
    if (it.status === "free") continue;
    const s = it.start?.dateTime;
    const e = it.end?.dateTime;
    if (!s || !e) continue;
    // Graph returns naive datetimes in the Prefer timezone (UTC here).
    busy.push({
      start: s.endsWith("Z") ? s : s + "Z",
      end: e.endsWith("Z") ? e : e + "Z",
    });
  }
  return busy;
}

export interface CreateEventInput {
  subject: string;
  startIso: string; // UTC ISO
  endIso: string; // UTC ISO
  description?: string;
  location?: string;
  online?: boolean; // adds a Teams meeting
  attendeeEmail?: string;
  attendeeName?: string;
}

export interface CreatedEvent {
  id: string;
  joinUrl: string;
  webLink: string;
}

/**
 * Create a calendar event on a mailbox via Graph. When `attendeeEmail` is
 * set, Graph emails the invite to the attendee (sendInvitations default).
 * When `online` is true, a Teams meeting is attached and the join URL is
 * returned. Used by api/schedule/book.ts.
 */
export async function createCalendarEvent(
  accessToken: string,
  mailboxEmail: string,
  input: CreateEventInput,
): Promise<CreatedEvent> {
  const eventBody: Record<string, any> = {
    subject: input.subject,
    body: { contentType: "HTML", content: input.description || "" },
    start: { dateTime: input.startIso, timeZone: "UTC" },
    end: { dateTime: input.endIso, timeZone: "UTC" },
    isOnlineMeeting: !!input.online,
    onlineMeetingProvider: input.online ? "teamsForBusiness" : undefined,
  };
  if (input.location) {
    eventBody.location = { displayName: input.location };
  }
  if (input.attendeeEmail) {
    eventBody.attendees = [
      {
        emailAddress: {
          address: input.attendeeEmail,
          name: input.attendeeName || input.attendeeEmail,
        },
        type: "required",
      },
    ];
  }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventBody),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph create event error (${resp.status}): ${err.slice(0, 300)}`);
  }

  const event = (await resp.json()) as any;
  return {
    id: event.id || event.iCalUId,
    joinUrl: event.onlineMeeting?.joinUrl || "",
    webLink: event.webLink || "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE INTERNAL EMAIL — fire-and-forget summary mails (e.g. reconcile run
// reports). Skips silently when sender/recipients aren't configured.
// ─────────────────────────────────────────────────────────────────────────────

export async function sendInternalEmail(
  fromEmail: string,
  toEmails: string[],
  subject: string,
  htmlBody: string,
): Promise<void> {
  if (!fromEmail || toEmails.length === 0) return;

  // Phase 2 of the Unipile-everywhere migration: when the kill-switch
  // USE_UNIPILE_EMAIL is on, route through Unipile Outlook. Falls back
  // to Graph on any error so a misconfigured Unipile account never
  // silently drops alerts/digests.
  if (await shouldUseUnipileEmail()) {
    try {
      await unipileSendEmail(getSupabaseAdmin(), {
        fromEmail,
        to: toEmails,
        subject,
        htmlBody,
      });
      return;
    } catch (err: any) {
      logger.warn("sendInternalEmail: Unipile failed, falling back to Graph", {
        fromEmail, error: err.message,
      });
    }
  }

  const accessToken = await getMicrosoftAccessToken();
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: htmlBody },
          toRecipients: toEmails.map((addr) => ({ emailAddress: { address: addr } })),
        },
        saveToSentItems: true,
      }),
    },
  );
  if (!resp.ok) {
    const err = await resp.text();
    logger.warn("sendInternalEmail failed", { fromEmail, toEmails, error: err.slice(0, 200) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS — create or update Outlook contact
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateContactData {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  current_title: string | null;
  current_company: string | null;
  linkedin_url: string | null;
}

function buildContactPayload(candidate: CandidateContactData) {
  const payload: Record<string, any> = {
    categories: ["Sully Recruit"],
  };

  if (candidate.first_name) payload.givenName = candidate.first_name;
  if (candidate.last_name) payload.surname = candidate.last_name;
  if (candidate.full_name) payload.displayName = candidate.full_name;
  if (candidate.current_title) payload.jobTitle = candidate.current_title;
  if (candidate.current_company) payload.companyName = candidate.current_company;

  if (candidate.email) {
    payload.emailAddresses = [
      { address: candidate.email, name: candidate.full_name || candidate.email },
    ];
  }

  if (candidate.phone) {
    payload.businessPhones = [candidate.phone];
  }

  if (candidate.linkedin_url) {
    payload.businessHomePage = candidate.linkedin_url;
  }

  return payload;
}

/**
 * Create or update an Outlook contact for a candidate.
 * Returns the Graph contact resource ID.
 */
export async function createOrUpdateOutlookContact(
  accessToken: string,
  ownerEmail: string,
  candidate: CandidateContactData,
  existingContactId?: string | null,
): Promise<string> {
  const payload = buildContactPayload(candidate);
  const userPath = `/users/${encodeURIComponent(ownerEmail)}/contacts`;

  if (existingContactId) {
    // Update existing contact
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0${userPath}/${existingContactId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    if (resp.ok) {
      const data = await resp.json();
      logger.info("Outlook contact updated", { ownerEmail, contactId: existingContactId });
      return data.id;
    }

    // If 404, contact was deleted in Outlook — fall through to create
    if (resp.status === 404) {
      logger.warn("Outlook contact not found, re-creating", { contactId: existingContactId });
    } else {
      const errText = await resp.text();
      throw new Error(`Graph PATCH contact error (${resp.status}): ${errText}`);
    }
  }

  // Create new contact
  const resp = await fetch(`https://graph.microsoft.com/v1.0${userPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Graph POST contact error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  logger.info("Outlook contact created", { ownerEmail, contactId: data.id });
  return data.id;
}
