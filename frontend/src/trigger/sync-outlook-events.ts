import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

/**
 * Scheduled task: pull upcoming Outlook calendar events and create/match
 * to-do items linked to candidates/contacts.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: sync-outlook-events
 *   Cron: 0 12 * * * (daily at noon UTC / 7 AM ET)
 */
export const syncOutlookEvents = schedules.task({
  id: "sync-outlook-events",
  run: async () => {
    const supabase = getSupabaseAdmin();

    // 1. Get active Microsoft integration accounts
    const { data: msAccounts } = await supabase
      .from("integration_accounts")
      .select("id, owner_user_id, user_id, access_token, refresh_token, provider, account_label")
      .eq("provider", "microsoft")
      .eq("is_active", true);

    if (!msAccounts?.length) {
      logger.info("No active Microsoft accounts found");
      return { events_synced: 0, events_matched: 0, ms_accounts_checked: 0 };
    }

    let eventsSynced = 0;
    let eventsMatched = 0;

    for (const acct of msAccounts) {
      const accessToken = acct.access_token;
      const userId = acct.owner_user_id || acct.user_id;
      if (!accessToken || !userId) continue;

      // 2. Fetch upcoming events from Microsoft Graph
      const now = new Date().toISOString();
      const twoWeeksLater = new Date(Date.now() + 14 * 86400000).toISOString();

      try {
        const graphResp = await fetch(
          `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${now}&endDateTime=${twoWeeksLater}&$select=subject,start,end,attendees,bodyPreview&$top=50&$orderby=start/dateTime`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (graphResp.status === 401) {
          logger.info(`Microsoft token expired for account ${acct.id}`);
          continue;
        }
        if (!graphResp.ok) continue;

        const events = ((await graphResp.json()) as any).value || [];

        // 3. For each event, create task if not already synced
        for (const event of events) {
          const subject = event.subject || "";
          const startDt = (event.start?.dateTime || "").slice(0, 10);
          if (!subject || !startDt) continue;

          // Check if task already exists
          const { data: existing } = await supabase
            .from("tasks")
            .select("id")
            .eq("title", `\uD83D\uDCC5 ${subject}`)
            .eq("due_date", startDt)
            .eq("created_by", userId)
            .limit(1);

          if (existing?.length) continue;

          // Create task
          const { data: taskData, error: taskErr } = await supabase
            .from("tasks")
            .insert({
              title: `\uD83D\uDCC5 ${subject}`,
              description: (event.bodyPreview || "").slice(0, 500) || `Outlook event: ${subject}`,
              priority: "medium",
              due_date: startDt,
              assigned_to: userId,
              created_by: userId,
            })
            .select("id")
            .single();

          if (taskErr || !taskData) continue;
          eventsSynced++;

          // 4. Match attendee emails to candidates/contacts
          const attendeeEmails = (event.attendees || [])
            .map((a: any) => a.emailAddress?.address?.toLowerCase())
            .filter(Boolean);

          for (const email of attendeeEmails) {
            // Try candidate match
            const { data: cand } = await supabase
              .from("candidates")
              .select("id")
              .eq("email", email)
              .limit(1);

            if (cand?.length) {
              await supabase.from("task_links").insert({
                task_id: taskData.id,
                entity_type: "candidate",
                entity_id: cand[0].id,
              });
              eventsMatched++;
              continue;
            }

            // Try contact match
            const { data: cont } = await supabase
              .from("contacts")
              .select("id")
              .eq("email", email)
              .limit(1);

            if (cont?.length) {
              await supabase.from("task_links").insert({
                task_id: taskData.id,
                entity_type: "contact",
                entity_id: cont[0].id,
              });
              eventsMatched++;
            }
          }
        }
      } catch (err: any) {
        logger.warn(`Graph API error for account ${acct.id}: ${err.message}`);
      }
    }

    const result = {
      events_synced: eventsSynced,
      events_matched: eventsMatched,
      ms_accounts_checked: msAccounts.length,
    };

    logger.info("Outlook sync complete", result);
    return result;
  },
});
