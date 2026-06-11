import { inngest } from "../client.js";
import { getSupabaseAdmin, getAppSetting } from "../../../../src/server-lib/supabase.js";
import { getMicrosoftAccessToken } from "../../../../src/server-lib/microsoft-graph.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";
import {
  fetchUnipileEventsForAccount,
  shouldUseUnipileCalendar,
} from "../../../../src/server-lib/unipile-calendar.js";
import { matchPersonByEmail as matchPersonByEmailHelper } from "../../../../src/server-lib/match-person-by-email.js";

/**
 * Pull each configured mailbox's upcoming Outlook calendar events and
 * upsert them as `tasks` (task_type='meeting'), with `meeting_attendees`
 * + `task_links` rows for any attendee that matches a candidate or
 * contact by email. Optionally pulls the same events from Unipile in
 * parallel (dedup on tasks.external_id) when the Unipile calendar flag
 * is enabled.
 *
 * Two registered Inngest functions share this body:
 *   - `sync-outlook-events` (cron, every 30m) — the regular sweep
 *   - `sync-outlook-events-once` (event: ops/sync-outlook-events.requested)
 *     — fires when the Tasks page hits /api/trigger-sync-outlook for an
 *     on-demand sync.
 */
async function runSyncOutlookEvents(logger: any) {
  const supabase = getSupabaseAdmin();

  let graphEmailsRaw = "";
  try {
    graphEmailsRaw = (await getAppSetting("MICROSOFT_GRAPH_ACCOUNT_EMAILS")) || "";
  } catch (err: any) {
    logger.warn("Failed to load MICROSOFT_GRAPH_ACCOUNT_EMAILS", { error: err?.message });
  }
  const graphEmails = new Set(
    graphEmailsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  if (graphEmails.size === 0) {
    logger.warn("No mailboxes configured (MICROSOFT_GRAPH_ACCOUNT_EMAILS empty)");
    return { events_synced: 0, events_matched: 0, mailboxes_checked: 0 };
  }

  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("email_address, owner_user_id")
    .eq("provider", "email")
    .eq("is_active", true);
  const ownerByEmail = new Map<string, string>();
  for (const a of accounts ?? []) {
    const e = (a.email_address || "").toLowerCase().trim();
    if (e && a.owner_user_id) ownerByEmail.set(e, a.owner_user_id);
  }

  let accessToken: string;
  try {
    accessToken = await getMicrosoftAccessToken();
  } catch (err: any) {
    await notifyError({ taskId: "sync-outlook-events", error: err, context: { phase: "token" } });
    return { events_synced: 0, events_matched: 0, mailboxes_checked: 0, error: err.message };
  }

  let totalSynced = 0;
  let totalMatched = 0;
  let mailboxesChecked = 0;
  const perMailbox: Array<{ email: string; synced: number; matched: number }> = [];

  for (const email of graphEmails) {
    mailboxesChecked++;
    const ownerUserId = ownerByEmail.get(email);
    try {
      const result = await syncMailbox(supabase, email, ownerUserId, accessToken, logger);
      totalSynced += result.synced;
      totalMatched += result.matched;
      perMailbox.push({ email, synced: result.synced, matched: result.matched });
    } catch (err: any) {
      await notifyError({
        taskId: "sync-outlook-events",
        error: err,
        context: { mailbox: email },
        severity: "WARN",
      });
    }
  }

  if (await shouldUseUnipileCalendar()) {
    const { data: unipileAccts } = await supabase
      .from("integration_accounts")
      .select("email_address, owner_user_id, unipile_account_id, unipile_provider")
      .eq("provider", "email")
      .eq("is_active", true)
      .not("unipile_account_id", "is", null);
    const unipileSummary: Array<{ email: string; pulled: number; new: number }> = [];
    const start = new Date().toISOString();
    const end = new Date(Date.now() + 14 * 86_400_000).toISOString();

    for (const acct of unipileAccts ?? []) {
      const e = (acct.email_address || "").toLowerCase();
      if (!graphEmails.has(e)) continue;
      try {
        const events = await fetchUnipileEventsForAccount(
          supabase,
          acct.unipile_account_id!,
          start,
          end,
        );
        let inserted = 0;
        for (const ev of events) {
          const dateOnly = ev.start_dt.slice(0, 10);
          const { data: existing } = await supabase
            .from("tasks")
            .select("id")
            .eq("external_id", ev.id)
            .limit(1);
          if (existing?.length) continue;

          const { error } = await supabase.from("tasks").insert({
            title: ev.subject,
            description: (ev.description || "").slice(0, 500) || "Outlook calendar event",
            priority: "medium",
            due_date: dateOnly,
            start_time: ev.start_dt.endsWith("Z") ? ev.start_dt : ev.start_dt + "Z",
            end_time: ev.end_dt
              ? (ev.end_dt.endsWith("Z") ? ev.end_dt : ev.end_dt + "Z")
              : null,
            timezone: ev.timezone || "UTC",
            task_type: "meeting",
            location: ev.location || null,
            meeting_url: ev.meetingUrl || null,
            assigned_to: acct.owner_user_id ?? null,
            created_by: acct.owner_user_id ?? null,
            external_id: ev.id,
          } as any);
          if (!error) inserted++;
        }
        unipileSummary.push({ email: e, pulled: events.length, new: inserted });
      } catch (err: any) {
        logger.warn("Unipile calendar fetch error (non-fatal)", { email: e, error: err.message });
      }
    }
    if (unipileSummary.length) {
      logger.info("Unipile calendar parallel sweep", { unipileSummary });
    }
  }

  const summary = {
    events_synced: totalSynced,
    events_matched: totalMatched,
    mailboxes_checked: mailboxesChecked,
    per_mailbox: perMailbox,
  };
  logger.info("Outlook calendar sync complete", summary);
  return summary;
}

export const syncOutlookEvents = inngest.createFunction(
  { id: "sync-outlook-events", name: "Sync Outlook calendar events (Inngest)" },
  { cron: "*/30 * * * *" },
  async ({ logger }) => runSyncOutlookEvents(logger),
);

/**
 * Manual one-off variant for the Tasks page "Sync Outlook" button. Send
 * via `inngest.send({ name: "ops/sync-outlook-events.requested" })` from
 * `/api/trigger-sync-outlook`.
 */
export const syncOutlookEventsOnce = inngest.createFunction(
  { id: "sync-outlook-events-once", name: "Sync Outlook calendar events (one-off, Inngest)" },
  { event: "ops/sync-outlook-events.requested" },
  async ({ logger }) => runSyncOutlookEvents(logger),
);

async function syncMailbox(
  supabase: any,
  mailboxEmail: string,
  ownerUserId: string | undefined,
  accessToken: string,
  logger: any,
): Promise<{ synced: number; matched: number; failed: number }> {
  const now = new Date().toISOString();
  const twoWeeksLater = new Date(Date.now() + 14 * 86_400_000).toISOString();

  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/calendarview` +
    `?startDateTime=${encodeURIComponent(now)}&endDateTime=${encodeURIComponent(twoWeeksLater)}` +
    `&$select=id,iCalUId,subject,start,end,attendees,bodyPreview,location,onlineMeeting,onlineMeetingUrl` +
    `&$top=50&$orderby=start/dateTime`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) {
    throw new Error(`Graph ${resp.status} for ${mailboxEmail}: ${(await resp.text()).slice(0, 200)}`);
  }
  const events = ((await resp.json()) as any).value || [];

  let synced = 0;
  let matched = 0;
  let failed = 0;

  for (const event of events) {
    const subject = event.subject || "";
    const externalId = event.id || event.iCalUId;
    const startDt = event.start?.dateTime || "";
    const endDt = event.end?.dateTime || "";
    if (!subject || !startDt) continue;

    if (externalId) {
      const { data: existing } = await supabase
        .from("tasks")
        .select("id")
        .eq("external_id", externalId)
        .limit(1);
      if (existing?.length) continue;
    } else {
      const dateOnly = startDt.slice(0, 10);
      const { data: existing } = await supabase
        .from("tasks")
        .select("id")
        .eq("title", subject)
        .eq("due_date", dateOnly)
        .eq("created_by", ownerUserId)
        .limit(1);
      if (existing?.length) continue;
    }

    const meetingUrl = event.onlineMeetingUrl || event.onlineMeeting?.joinUrl || "";
    const locationText = event.location?.displayName || "";
    const dateOnly = startDt.slice(0, 10);

    const attendeeEmails: string[] = (event.attendees || [])
      .map((a: any) => a.emailAddress?.address?.toLowerCase())
      .filter(Boolean);

    const attendeeMatches: { entityId: string; entityType: string; email: string }[] = [];
    for (const e of attendeeEmails) {
      const m = await matchByEmail(supabase, e);
      if (m) attendeeMatches.push({ ...m, email: e });
    }

    const { data: taskData, error: taskErr } = await supabase
      .from("tasks")
      .insert({
        title: subject,
        description: (event.bodyPreview || "").slice(0, 500) || "Outlook calendar event",
        priority: "medium",
        due_date: dateOnly,
        start_time: startDt.endsWith("Z") ? startDt : startDt + "Z",
        end_time: endDt ? (endDt.endsWith("Z") ? endDt : endDt + "Z") : null,
        timezone: event.start?.timeZone || "UTC",
        task_type: "meeting",
        location: locationText || null,
        meeting_url: meetingUrl || null,
        assigned_to: ownerUserId ?? null,
        created_by: ownerUserId ?? null,
        external_id: externalId || null,
      } as any)
      .select("id")
      .single();

    if (taskErr || !taskData) {
      logger.warn("Failed to insert task", { error: taskErr?.message, subject });
      failed++;
      continue;
    }
    synced++;

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

  return { synced, matched, failed };
}

async function matchByEmail(
  supabase: any,
  email: string,
): Promise<{ entityId: string; entityType: string } | null> {
  const m = await matchPersonByEmailHelper(supabase, email);
  return m ? { entityId: m.entityId, entityType: m.entityType } : null;
}
