import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getMicrosoftGraphCredentials } from "./lib/supabase";

/**
 * Scheduled task: pull upcoming Outlook calendar events and create/match
 * tasks (type=meeting) linked to candidates/contacts via meeting_attendees.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: sync-outlook-events
 *   Cron: 0 12 * * * (daily at noon UTC / 7 AM ET)
 *
 * Token sources (checked in order):
 *   1. user_integrations where integration_type = 'microsoft_oauth' (per-user delegated tokens)
 *   2. Fallback: app-level client_credentials grant via MICROSOFT_GRAPH_* settings
 */
export const syncOutlookEvents = schedules.task({
  id: "sync-outlook-events",
  run: async () => {
    const supabase = getSupabaseAdmin();

    let eventsSynced = 0;
    let eventsMatched = 0;
    let accountsChecked = 0;

    // ── Per-user delegated tokens from user_integrations ──────────────
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
      accountsChecked++;

      // Refresh token if expired (or within 5-minute buffer)
      if (expiresAt && new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000) {
        if (!refreshToken) {
          logger.warn(`Token expired and no refresh token for user ${userId} — marking inactive`);
          await supabase
            .from("user_integrations")
            .update({ is_active: false } as any)
            .eq("user_id", userId)
            .eq("integration_type", "microsoft_oauth");
          continue;
        }
        accessToken = await refreshAccessToken(supabase, userId, refreshToken);
        if (!accessToken) continue;
      }

      const result = await syncEventsForUser(supabase, userId, accessToken);
      if (result.tokenExpired) {
        // Try refresh once
        if (refreshToken) {
          const newToken = await refreshAccessToken(supabase, userId, refreshToken);
          if (newToken) {
            const retry = await syncEventsForUser(supabase, userId, newToken);
            eventsSynced += retry.synced;
            eventsMatched += retry.matched;
          }
        } else {
          await supabase
            .from("user_integrations")
            .update({ is_active: false } as any)
            .eq("user_id", userId)
            .eq("integration_type", "microsoft_oauth");
        }
      } else {
        eventsSynced += result.synced;
        eventsMatched += result.matched;
      }
    }

    // ── Fallback: app-level integration_accounts (legacy) ─────────────
    const { data: legacyAccounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, provider, account_label, is_active")
      .eq("provider", "microsoft")
      .eq("is_active", true);

    // Only process legacy accounts that DON'T already have a user_integrations row
    const usersWithDelegated = new Set((userIntegrations || []).map((r: any) => r.user_id));

    for (const acct of legacyAccounts || []) {
      const userId = acct.owner_user_id;
      if (!userId || usersWithDelegated.has(userId)) continue;

      // Use app-level client_credentials for this account
      try {
        const appToken = await getAppLevelToken();
        if (!appToken) continue;
        accountsChecked++;
        const result = await syncEventsForUser(supabase, userId, appToken);
        eventsSynced += result.synced;
        eventsMatched += result.matched;
      } catch (err: any) {
        logger.warn(`Legacy sync error for account ${acct.id}: ${err.message}`);
      }
    }

    const summary = {
      events_synced: eventsSynced,
      events_matched: eventsMatched,
      accounts_checked: accountsChecked,
    };

    logger.info("Outlook calendar sync complete", summary);
    return summary;
  },
});

// ── Sync events for a single user ──────────────────────────────────────────

async function syncEventsForUser(
  supabase: any,
  userId: string,
  accessToken: string,
): Promise<{ synced: number; matched: number; tokenExpired: boolean }> {
  const now = new Date().toISOString();
  const twoWeeksLater = new Date(Date.now() + 14 * 86400000).toISOString();

  let synced = 0;
  let matched = 0;

  try {
    const graphResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarview` +
        `?startDateTime=${now}&endDateTime=${twoWeeksLater}` +
        `&$select=id,iCalUId,subject,start,end,attendees,bodyPreview,location,onlineMeeting,webLink,isOnlineMeeting,onlineMeetingUrl` +
        `&$top=50&$orderby=start/dateTime`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (graphResp.status === 401) {
      logger.warn(`Token expired for user ${userId}`);
      return { synced: 0, matched: 0, tokenExpired: true };
    }
    if (!graphResp.ok) {
      logger.warn(`Graph API ${graphResp.status} for user ${userId}`);
      return { synced: 0, matched: 0, tokenExpired: false };
    }

    const events = ((await graphResp.json()) as any).value || [];

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

      // Also dedup by title + date (fallback for events without external_id)
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

      // Extract meeting URL
      const meetingUrl =
        event.onlineMeetingUrl ||
        event.onlineMeeting?.joinUrl ||
        "";

      // Extract location
      const locationText = event.location?.displayName || "";

      // Match attendee emails to candidates/contacts
      const attendeeEmails: string[] = (event.attendees || [])
        .map((a: any) => a.emailAddress?.address?.toLowerCase())
        .filter(Boolean);

      const attendeeMatches: { entityId: string; entityType: string; email: string }[] = [];

      for (const email of attendeeEmails) {
        const match = await matchByEmail(supabase, email);
        if (match) {
          attendeeMatches.push({ ...match, email });
        }
      }

      // Create the task as a meeting
      const { data: taskData, error: taskErr } = await supabase
        .from("tasks")
        .insert({
          title: subject,
          description: (event.bodyPreview || "").slice(0, 500) || `Outlook calendar event`,
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

      if (taskErr || !taskData) {
        logger.warn("Failed to insert task", { error: taskErr?.message, subject });
        continue;
      }
      synced++;

      // Insert meeting_attendees for matched people
      for (const m of attendeeMatches) {
        await supabase.from("meeting_attendees").insert({
          task_id: taskData.id,
          entity_type: m.entityType,
          entity_id: m.entityId,
        } as any);

        // Also create task_links so the event shows up on entity pages
        await supabase.from("task_links").insert({
          task_id: taskData.id,
          entity_type: m.entityType,
          entity_id: m.entityId,
        } as any);

        matched++;
      }
    }
  } catch (err: any) {
    logger.warn(`Graph API error for user ${userId}: ${err.message}`);
  }

  return { synced, matched, tokenExpired: false };
}

// ── Token refresh ──────────────────────────────────────────────────────────

async function refreshAccessToken(
  supabase: any,
  userId: string,
  refreshToken: string,
): Promise<string | null> {
  try {
    const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: "openid profile email offline_access Calendars.Read Calendars.ReadWrite Mail.Read Mail.Send User.Read",
      }),
    });

    if (!resp.ok) {
      logger.error(`Token refresh failed for user ${userId}`, { status: resp.status });
      await supabase
        .from("user_integrations")
        .update({ is_active: false } as any)
        .eq("user_id", userId)
        .eq("integration_type", "microsoft_oauth");
      return null;
    }

    const data = await resp.json();
    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();

    // Update stored tokens
    const { data: existing } = await supabase
      .from("user_integrations")
      .select("config")
      .eq("user_id", userId)
      .eq("integration_type", "microsoft_oauth")
      .maybeSingle();

    const existingConfig = (existing?.config || {}) as Record<string, string>;

    await supabase
      .from("user_integrations")
      .update({
        config: {
          ...existingConfig,
          access_token: data.access_token,
          refresh_token: data.refresh_token || refreshToken,
          expires_at: expiresAt,
        },
      })
      .eq("user_id", userId)
      .eq("integration_type", "microsoft_oauth");

    logger.info(`Refreshed token for user ${userId}`);
    return data.access_token;
  } catch (err: any) {
    logger.error(`Token refresh error for user ${userId}: ${err.message}`);
    return null;
  }
}

// ── App-level token (client_credentials grant) ─────────────────────────────

async function getAppLevelToken(): Promise<string | null> {
  try {
    const { clientId, clientSecret, tenantId } = await getMicrosoftGraphCredentials();

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

    if (!resp.ok) return null;
    const data = await resp.json();
    return data.access_token;
  } catch {
    return null;
  }
}

// ── Email matching ─────────────────────────────────────────────────────────

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
