import { serve } from "inngest/vercel";
import { inngest } from "../src/inngest/client.js";
import { bulkMigrateSequences } from "../src/inngest/functions/bulk-migrate-sequences.js";
import { migrateSequenceToInngest } from "../src/inngest/functions/migrate-sequence-to-inngest.js";
import { sequenceRun } from "../src/inngest/functions/sequence-run.js";

/**
 * Inngest Vercel handler. Receives signed event-delivery webhooks from Inngest
 * Cloud and dispatches them to the registered functions. Health-check GETs to
 * /api/inngest return the function manifest, which is also how Inngest
 * discovers what's deployed when you run `inngest sync`.
 */
export default serve({
  client: inngest,
  functions: [bulkMigrateSequences, migrateSequenceToInngest, sequenceRun],
});
