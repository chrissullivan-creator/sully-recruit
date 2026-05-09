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
];
