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
import { cleanupStaleEnrollments } from "./lib/inngest/functions/cleanup-stale-enrollments.js";
import { pendingConnectionTimeout } from "./lib/inngest/functions/pending-connection-timeout.js";
import {
  reclassifyLinkedinChatsDaily,
  reclassifyLinkedinChatsOnce,
} from "./lib/inngest/functions/reclassify-linkedin-chats.js";
import { resolveUnipileIds } from "./lib/inngest/functions/resolve-unipile-ids.js";
import { renewWebhookSubscriptions } from "./lib/inngest/functions/renew-webhook-subscriptions.js";
import { backfillResumeEmbeddings } from "./lib/inngest/functions/backfill-resume-embeddings.js";
import { reparseResumes } from "./lib/inngest/functions/reparse-resumes.js";
import { reconcileOrphanedResumes } from "./lib/inngest/functions/reconcile-orphaned-resumes.js";
import { syncOutlookEvents } from "./lib/inngest/functions/sync-outlook-events.js";
import { syncPeopleToOutlook } from "./lib/inngest/functions/sync-people-to-outlook.js";
import { syncConversations } from "./lib/inngest/functions/sync-conversations.js";
import { purgeMarketingEmails } from "./lib/inngest/functions/purge-marketing-emails.js";
import { backfillEmails } from "./lib/inngest/functions/backfill-emails.js";
import { backfillLinkedinMessages } from "./lib/inngest/functions/backfill-linkedin-messages.js";
import { drainCallQueue } from "./lib/inngest/functions/drain-call-queue.js";
import { pipelineHealthDigest } from "./lib/inngest/functions/pipeline-health-digest.js";
import {
  syncProxyConfigDaily,
  syncProxyConfigOnce,
} from "./lib/inngest/functions/sync-proxy-config.js";
import { processCallDeepgram } from "./lib/inngest/functions/process-call-deepgram.js";
import { pollRcCalls, backfillRcCalls } from "./lib/inngest/functions/poll-rc-calls.js";
import { retryStuckCallTranscripts } from "./lib/inngest/functions/retry-stuck-call-transcripts.js";
import { processRingcentralEvent } from "./lib/inngest/functions/process-ringcentral-event.js";
import { processUnipileEvent } from "./lib/inngest/functions/process-unipile-event.js";
import { processMicrosoftEvent } from "./lib/inngest/functions/process-microsoft-event.js";

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
    cleanupStaleEnrollments,
    pendingConnectionTimeout,
    reclassifyLinkedinChatsDaily,
    reclassifyLinkedinChatsOnce,
    resolveUnipileIds,
    renewWebhookSubscriptions,
    backfillResumeEmbeddings,
    reparseResumes,
    reconcileOrphanedResumes,
    syncOutlookEvents,
    syncPeopleToOutlook,
    syncConversations,
    purgeMarketingEmails,
    backfillEmails,
    backfillLinkedinMessages,
    drainCallQueue,
    pipelineHealthDigest,
    syncProxyConfigDaily,
    syncProxyConfigOnce,
    processCallDeepgram,
    pollRcCalls,
    backfillRcCalls,
    retryStuckCallTranscripts,
    processRingcentralEvent,
    processUnipileEvent,
    processMicrosoftEvent,
  ],
});
