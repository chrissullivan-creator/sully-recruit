import { serve } from "inngest/express";
import { inngest } from "./lib/inngest/client.js";
import { bulkMigrateSequences } from "./lib/inngest/functions/bulk-migrate-sequences.js";
import { migrateSequenceToInngest } from "./lib/inngest/functions/migrate-sequence-to-inngest.js";
import { sequenceRun } from "./lib/inngest/functions/sequence-run.js";

/**
 * Inngest Vercel handler. Receives signed event-delivery webhooks from Inngest
 * Cloud and dispatches them to the registered functions. Health-check GETs to
 * /api/inngest return the function manifest, which is also how Inngest
 * discovers what's deployed when you run `inngest sync`.
 *
 * Note: we use `inngest/express` (not the legacy `inngest/vercel`, which was
 * removed in v3). The express handler returns a `(req, res, next?) => void`
 * shape that's compatible with `@vercel/node`'s function signature — Vercel
 * just ignores the optional `next` arg.
 */
export default serve({
  client: inngest,
  functions: [bulkMigrateSequences, migrateSequenceToInngest, sequenceRun],
});
