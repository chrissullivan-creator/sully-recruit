import { inngest } from "../client";
import { runBackfillCalendarEvents } from "../../trigger/backfill-calendar-events";

/**
 * On-demand backfill of historical Microsoft Graph calendar events.
 * Pulls last `monthsBack` months of events, creates meeting tasks,
 * tags people, re-links missing meeting_attendees on existing rows.
 *
 * Long-running. No cron — fires only on the
 * `calendar/backfill-events.requested` event (e.g. from a Tasks page
 * "Resync history" button or the Trigger.dev cutover migration).
 */
export const backfillCalendarEvents = inngest.createFunction(
  {
    id: "backfill-calendar-events",
    retries: 1,
    triggers: [{ event: "calendar/backfill-events.requested" }],
  },
  async ({ event, step }) => {
    const payload = (event.data ?? {}) as { monthsBack?: number };
    return step.run("run", () => runBackfillCalendarEvents(payload));
  },
);
