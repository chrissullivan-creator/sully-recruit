import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getMicrosoftGraphCredentials } from "./lib/supabase";

/**
 * One-shot backfill: pull historical Outlook calendar events and sync them
 * as meeting tasks with people tagging.
 *
 * Trigger manually from Trigger.dev Dashboard or via API:
 *   Task: backfill-calendar-events
 *   Payload: { monthsBack?: number }  (default 6)
 *
 * Token sources (in order):
 *   1. Per-user delegated tokens from user_integrations (microsoft_oauth)
 *   2. App-level client_credentials → queries each team member's mailbox
 *      via /users/{email}/calendarview
 *
 * Two passes:
 *   1. Pull historical events from Graph API → create meeting tasks + tag people
 *   2. Re-link any existing calendar tasks that are missing meeting_attendees
 */
export const backfillCalendarEvents = task({
  id: "backfill-calendar-events",
  retry: { maxAttempts: 1 },
  run: async (payload: { monthsBack?: number } = {}) => {
    const supabase = getSupabaseAdmin();
    const monthsBack = payload.monthsBack ?? 6;

    let eventsSynced = 0;
    let eventsMatched = 0;
    let existingRelinked = 0;
    let accountsProcessed = 0;

    const now = new Date();
    const startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - monthsBack);

    // Track which user emails we've already processed (avoid double-syncing)
    const processedEmails = new Set<string>();

    // ════════════════════════════════════════════════════════════════
    // SOURCE 1: Per-user delegated tokens from user_integrations
    // ════════════════════════════════════════════════════════════════

    const { data: userIntegrations } = await supabase
      .from("user_integrations")
      .select("user_id, config, is_active")
      .eq("integration_type", "microsoft_oauth")
      .eq("is_active", true);

    for (const row of userIntegrations || []) {
      const userId = row.user_id;
      const config = (row.config || {}) as Record<string, string>;
      let accessToken = config.access_token;
      const refreshToken = config.refresh_token;
      const expiresAt = config.expires_at;

      if (!accessToken || !userId) continue;

      // Refresh token if needed
      if (expiresAt && new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000) {
        if (!refreshToken) continue;
        accessToken = await refreshAccessToken(supabase, userId, refreshToken);
        if (!accessToken) continue;
      }

      // Track this email so we don't double-process with app credentials
      if (config.email_address) processedEmails.add(config.email_address.toLowerCase());

      accountsProcessed++;
      const baseUrl = `https://graph.microsoft.com/v1.0/me/calendarview`;
      const result = await syncCalendarForUser(supabase, userId, accessToken, baseUrl, startDate, now);
      eventsSynced += result.synced;
      eventsMatched += result.matched;
    }

    // ════════════════════════════════════════════════════════════════
    // SOURCE 2: App-level client_credentials for team mailboxes
    // ════════════════════════════════════════════════════════════════

    logger.info("Attempting app-level token for team mailbox scan...");
    let appToken: string | null = null;
    let tokenError: string | null = null;
    try {
      appToken = await getAppLevelToken();
      if (!appToken) tokenError = "Token request returned null (check credentials)";
      logger.info(appToken ? "Got app-level token" : "App-level token returned null");
    } catch (err: any) {
      tokenError = err.message || String(err);
      logger.error("App-level token error", { error: tokenError });
    }

    let profileCount = 0;
    let profileEmails: string[] = [];
    let profileError: string | null = null;

    if (appToken) {
      // Get all team members from profiles
      const { data: profiles, error: profileErr } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .not("email", "is", null);

      profileCount = (profiles || []).length;
      profileEmails = (profiles || []).map((p: any) => p.email).filter(Boolean);
      profileError = profileErr?.message || null;

      logger.info(`Found ${profileCount} profiles with emails`, { emails: profileEmails });

      for (const profile of profiles || []) {
        const email = (profile.email || "").toLowerCase();
        if (!email || processedEmails.has(email)) continue;

        // Use /users/{email}/calendarview with app-level token
        const baseUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarview`;

        logger.info(`Syncing calendar for ${email} (${profile.full_name}) via app credentials`);
        accountsProcessed++;

        const result = await syncCalendarForUser(supabase, profile.id, appToken, baseUrl, startDate, now);
        logger.info(`${email}: synced=${result.synced}, matched=${result.matched}`);
        eventsSynced += result.synced;
        eventsMatched += result.matched;

        // Rate limit between mailboxes
        await delay(1000);
      }
    } else {
      logger.error("No app-level token — cannot scan team mailboxes.");
    }

    // ════════════════════════════════════════════════════════════════
    // PASS 2: Re-link existing calendar tasks missing attendees
    // ════════════════════════════════════════════════════════════════

    const { data: orphanTasks } = await supabase
      .from("tasks")
      .select("id, title, description, external_id, created_by")
      .eq("task_type", "meeting")
      .not("external_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);

    for (const t of orphanTasks || []) {
      // Check if already has attendees
      const { data: existingAttendees } = await supabase
        .from("meeting_attendees")
        .select("id")
        .eq("task_id", t.id)
        .limit(1);

      if (existingAttendees?.length) continue;

      // Try to extract emails from the description (format: "Calendar event with email@...: ...")
      const emailPattern = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
      const desc = t.description || t.title || "";
      const emails = (desc.match(emailPattern) || [])
        .map((e: string) => e.toLowerCase())
        .filter((e: string) =>
          !e.includes("emeraldrecruit") &&
          !e.includes("theemeraldrecruitinggroup") &&
          !e.includes("noreply")
        );

      if (emails.length === 0) continue;

      for (const email of emails) {
        const match = await matchByEmail(supabase, email);
        if (match) {
          // Check for existing link to avoid duplicates
          const { data: existingLink } = await supabase
            .from("meeting_attendees")
            .select("id")
            .eq("task_id", t.id)
            .eq("entity_id", match.entityId)
            .limit(1);
          if (existingLink?.length) continue;

          await supabase.from("meeting_attendees").insert({
            task_id: t.id,
            entity_type: match.entityType,
            entity_id: match.entityId,
          } as any);

          // Also ensure task_links exists
          const { data: existingTL } = await supabase
            .from("task_links")
            .select("id")
            .eq("task_id", t.id)
            .eq("entity_id", match.entityId)
            .limit(1);
          if (!existingTL?.length) {
            await supabase.from("task_links").insert({
              task_id: t.id,
              entity_type: match.entityType,
              entity_id: match.entityId,
            } as any);
          }

          existingRelinked++;
        }
      }
    }

    const summary = {
      accounts_processed: accountsProcessed,
      events_synced: eventsSynced,
      events_matched: eventsMatched,
      existing_relinked: existingRelinked,
      months_back: monthsBack,
      // Diagnostic info
      user_integrations_count: (userIntegrations || []).length,
      app_token_acquired: !!appToken,
      token_error: tokenError,
      profile_count: profileCount,
      profile_emails: profileEmails,
      profile_error: profileError,
    };

    logger.info("Calendar backfill complete", summary);
    return summary;
  },
});

// ── Process a batch of Graph calendar events ──────────────────────────────

async function processEventBatch(
  supabase: any,
  userId: string,
  events: any[],
): Promise<{ synced: number; matched: number }> {
  let synced = 0;
  let matched = 0;

  for (const event of events) {
    const subject = event.subject || "";
    const externalId = event.id || event.iCalUId;
    const startDt = event.start?.dateTime || "";
    const endDt = event.end?.dateTime || "";
    if (!subject || !startDt) continue;

    // Dedup by external_id
    if (externalId) {
      const { data: existing } = await supabase
        .from("tasks")
        .select("id")
        .eq("external_id", externalId)
        .limit(1);
      if (existing?.length) continue;
    }

    // Also dedup by title + date
    const dateOnly = startDt.slice(0, 10);
    if (!externalId) {
      const { data: existing } = await supabase
        .from("tasks")
        .select("id")
        .eq("title", subject)
        .eq("due_date", dateOnly)
        .eq("created_by", userId)
        .limit(1);
      if (existing?.length) continue;
    }

    // Extract meeting metadata
    const meetingUrl =
      event.onlineMeetingUrl ||
      event.onlineMeeting?.joinUrl ||
      "";
    const locationText = event.location?.displayName || "";

    // Match attendee emails
    const attendeeEmails: string[] = (event.attendees || [])
      .map((a: any) => a.emailAddress?.address?.toLowerCase())
      .filter(Boolean);

    const attendeeMatches: { entityId: string; entityType: string; email: string }[] = [];
    for (const email of attendeeEmails) {
      const match = await matchByEmail(supabase, email);
      if (match) attendeeMatches.push({ ...match, email });
    }

    // Create meeting task
    const { data: taskData, error: taskErr } = await supabase
      .from("tasks")
      .insert({
        title: subject,
        description: attendeeMatches.length
          ? `Calendar event with ${attendeeMatches.map(m => m.email).join(", ")}: ${(event.bodyPreview || "").slice(0, 400)}`
          : (event.bodyPreview || "").slice(0, 500) || "Outlook calendar event",
        priority: "medium",
        due_date: dateOnly,
        start_time: startDt.endsWith("Z") ? startDt : startDt + "Z",
        end_time: endDt ? (endDt.endsWith("Z") ? endDt : endDt + "Z") : null,
        timezone: event.start?.timeZone || "UTC",
        task_type: "meeting",
        location: locationText || null,
        meeting_url: meetingUrl || null,
        assigned_to: userId,
        created_by: userId,
        external_id: externalId || null,
      } as any)
      .select("id")
      .single();

    if (taskErr || !taskData) continue;
    synced++;

    // Link matched people
    for (const m of attendeeMatches) {
      await supabase.from("meeting_attendees").insert({
        task_id: taskData.id,
        entity_type: m.entityType,
        entity_id: m.entityId,
      } as any);

      await supabase.from("task_links").insert({
        task_id: taskData.id,
        entity_type: m.entityType,
        entity_id: m.entityId,
      } as any);

      matched++;
    }
  }

  return { synced, matched };
}

// ── Fetch all calendar events for a single user ──────────────────────────

async function syncCalendarForUser(
  supabase: any,
  userId: string,
  accessToken: string,
  calendarBaseUrl: string,
  startDate: Date,
  endDate: Date,
): Promise<{ synced: number; matched: number }> {
  let synced = 0;
  let matched = 0;
  let totalEvents = 0;

  const pageUrl =
    `${calendarBaseUrl}` +
    `?startDateTime=${startDate.toISOString()}&endDateTime=${endDate.toISOString()}` +
    `&$select=id,iCalUId,subject,start,end,attendees,bodyPreview,location,onlineMeeting,isOnlineMeeting,onlineMeetingUrl` +
    `&$top=100&$orderby=start/dateTime`;

  let nextLink: string | null = null;

  do {
    const url = nextLink || pageUrl;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!resp.ok) {
        const status = resp.status;
        if (status === 404) {
          logger.info(`Mailbox not found (404) — skipping`);
          break;
        }
        logger.warn(`Graph API ${status} for calendar fetch`);
        break;
      }

      const data = await resp.json();
      const events = data.value || [];
      nextLink = data["@odata.nextLink"] || null;
      totalEvents += events.length;

      const result = await processEventBatch(supabase, userId, events);
      synced += result.synced;
      matched += result.matched;

      if (nextLink) await delay(300);
    } catch (err: any) {
      logger.warn(`Graph error: ${err.message}`);
      break;
    }
  } while (nextLink);

  if (totalEvents > 0) {
    logger.info(`Scanned ${totalEvents} events, synced ${synced}, matched ${matched}`);
  }

  return { synced, matched };
}

// ── App-level token (client_credentials grant) ─────────────────────────

async function getAppLevelToken(): Promise<string | null> {
  const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();
  logger.info("Got Graph credentials", { clientId: clientId?.slice(0, 8) + "...", tenantId: tenantId?.slice(0, 8) + "..." });

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    logger.error("App token request failed", { status: resp.status, body: errText.slice(0, 500) });
    return null;
  }

  const data = await resp.json();
  logger.info("App-level token obtained successfully");
  return data.access_token;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function matchByEmail(
  supabase: any,
  email: string,
): Promise<{ entityId: string; entityType: string } | null> {
  const normalized = email.toLowerCase().trim();

  const [candidateRes, contactRes] = await Promise.all([
    supabase.from("people").select("id").ilike("email", normalized).limit(1),
    supabase.from("contacts").select("id").ilike("email", normalized).limit(1),
  ]);

  if (candidateRes.data?.[0]) {
    return { entityId: candidateRes.data[0].id, entityType: "candidate" };
  }
  if (contactRes.data?.[0]) {
    return { entityId: contactRes.data[0].id, entityType: "contact" };
  }
  return null;
}

async function refreshAccessToken(
  supabase: any,
  userId: string,
  refreshToken: string,
): Promise<string | null> {
  try {
    const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

    const resp = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: "openid profile email offline_access Calendars.Read Calendars.ReadWrite Mail.Read Mail.Send User.Read",
        }),
      },
    );

    if (!resp.ok) {
      logger.error(`Token refresh failed for user ${userId}`, { status: resp.status });
      return null;
    }

    const data = await resp.json();
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

    const { data: existing } = await supabase
      .from("user_integrations")
      .select("config")
      .eq("user_id", userId)
      .eq("integration_type", "microsoft_oauth")
      .maybeSingle();

    await supabase
      .from("user_integrations")
      .update({
        config: {
          ...((existing?.config || {}) as Record<string, string>),
          access_token: data.access_token,
          refresh_token: data.refresh_token || refreshToken,
          expires_at: expiresAt,
        },
      })
      .eq("user_id", userId)
      .eq("integration_type", "microsoft_oauth");

    return data.access_token;
  } catch (err: any) {
    logger.error(`Token refresh error: ${err.message}`);
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
