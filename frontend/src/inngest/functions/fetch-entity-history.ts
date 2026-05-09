import { inngest } from "../client";
import { runFetchEntityHistory } from "../../trigger/fetch-entity-history";

/**
 * Inngest port of fetch-entity-history (the Contacts page "Fetch
 * History" button). Single source of truth lives in the Trigger.dev
 * file as `runFetchEntityHistory`.
 */
export const fetchEntityHistory = inngest.createFunction(
  {
    id: "fetch-entity-history",
    retries: 2,
    triggers: [{ event: "entity/history-requested" }],
    concurrency: [{ key: "event.data.contact_id", limit: 1 }],
  },
  async ({ event, step }) => {
    const { contact_id } = event.data as { contact_id: string };
    if (!contact_id) return { skipped: true, reason: "missing_contact_id" };
    return step.run("run", () => runFetchEntityHistory({ contact_id }));
  },
);
