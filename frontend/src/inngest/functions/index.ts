/**
 * Single export list of every Inngest function. The Vercel serve
 * handler at /api/inngest passes this array to `serve({ functions })`,
 * so adding a new migration is one entry here plus the function file.
 */
import { syncInmailCredits } from "./sync-inmail-credits";
import { sequenceRun } from "./sequence-run";
import { cancelOnReply } from "./cancel-on-reply";
import { generateJoeSays } from "./generate-joe-says";
import { sendMessage } from "./send-message";
import { extractCallIntel } from "./extract-call-intel";
import { fetchEntityHistory } from "./fetch-entity-history";
import { checkConnections } from "./check-connections";
import { syncLinkedinInvitations } from "./sync-linkedin-invitations";
import { pendingConnectionTimeout } from "./pending-connection-timeout";
import { resumeIngestion } from "./resume-ingestion";
import { syncOutlookEvents } from "./sync-outlook-events";
import { backfillEmails } from "./backfill-emails";
import { backfillLinkedinMessages } from "./backfill-linkedin-messages";
import { backfillEnrollmentInit } from "./backfill-enrollment-init";
import { reconcileOrphanedResumes } from "./reconcile-orphaned-resumes";
import { processMicrosoftEvent } from "./process-microsoft-event";
import { processUnipileEvent } from "./process-unipile-event";
import { processRingcentralEvent } from "./process-ringcentral-event";
import { cleanupStaleEnrollments } from "./cleanup-stale-enrollments";
import { retryStuckCallTranscripts } from "./retry-stuck-call-transcripts";
import { syncPeopleToOutlook } from "./sync-people-to-outlook";
import { drainCallQueue } from "./drain-call-queue";
import { reclassifyLinkedinChatsDaily } from "./reclassify-linkedin-chats";
import { backfillResumeEmbeddings } from "./backfill-resume-embeddings";
import { syncConversations } from "./sync-conversations";
import { pollRcCalls } from "./poll-rc-calls";
import { renewWebhookSubscriptions } from "./webhook-subscription-renewal";
import { backfillCalendarEvents } from "./backfill-calendar-events";
import { processCallDeepgram } from "./process-call-deepgram";
import { recoverOrphanResumes } from "./recover-orphan-resumes";
import { processClayEnrichment } from "./process-clay-enrichment";
import { migrateSequenceToInngest } from "./migrate-sequence-to-inngest";
import { bulkMigrateSequences } from "./bulk-migrate-sequences";
import { rescueOrphanEnrollments } from "./rescue-orphan-enrollments";

export const functions = [
  syncInmailCredits,
  sequenceRun,
  cancelOnReply,
  generateJoeSays,
  sendMessage,
  extractCallIntel,
  fetchEntityHistory,
  checkConnections,
  syncLinkedinInvitations,
  pendingConnectionTimeout,
  resumeIngestion,
  syncOutlookEvents,
  backfillEmails,
  backfillLinkedinMessages,
  backfillEnrollmentInit,
  reconcileOrphanedResumes,
  processMicrosoftEvent,
  processUnipileEvent,
  processRingcentralEvent,
  cleanupStaleEnrollments,
  retryStuckCallTranscripts,
  syncPeopleToOutlook,
  drainCallQueue,
  reclassifyLinkedinChatsDaily,
  backfillResumeEmbeddings,
  syncConversations,
  pollRcCalls,
  renewWebhookSubscriptions,
  backfillCalendarEvents,
  processCallDeepgram,
  recoverOrphanResumes,
  processClayEnrichment,
  migrateSequenceToInngest,
  bulkMigrateSequences,
  rescueOrphanEnrollments,
];
