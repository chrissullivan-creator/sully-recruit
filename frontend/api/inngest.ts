import { serve } from "inngest/express";
import { inngest } from "./lib/inngest/client.js";
import { bulkMigrateSequences } from "./lib/inngest/functions/bulk-migrate-sequences.js";
import { migrateSequenceToInngest } from "./lib/inngest/functions/migrate-sequence-to-inngest.js";
import { sequenceSweep } from "./lib/inngest/functions/sequence-sweep.js";
import { sequenceActionExecute } from "./lib/inngest/functions/sequence-action-execute.js";
import { sequenceEnrollmentInit } from "./lib/inngest/functions/sequence-enrollment-init.js";
import { checkConnections } from "./lib/inngest/functions/check-connections.js";
import { syncInmailCredits } from "./lib/inngest/functions/sync-inmail-credits.js";
import { syncLinkedinInvitations } from "./lib/inngest/functions/sync-linkedin-invitations.js";

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
  functions: [
    bulkMigrateSequences,
    migrateSequenceToInngest,
    sequenceSweep,
    sequenceActionExecute,
    sequenceEnrollmentInit,
    checkConnections,
    syncInmailCredits,
    syncLinkedinInvitations,
  ],
});
