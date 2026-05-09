import { Inngest } from "inngest";

/**
 * Single-tenant Inngest client. All Sully background work goes through
 * this app id. Event keys are per-event-source.
 *
 * On Vercel, INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY come from project env;
 * locally, the dev server runs unsigned with `npx inngest-cli@latest dev`.
 */
export const inngest = new Inngest({
  id: "sully-recruit",
});

// ─── Event registry ─────────────────────────────────────────────────────────
// Names live here so a typo in a `send` call surfaces as a TS error, not a
// silently-dropped event.

export type BulkMigrateSequencesRequested = {
  name: "infra/bulk-migrate-sequences.requested";
  data: {
    /**
     * Optional. Falls back per-sequence to `sender_user_id` then `created_by`
     * inside the migrate-sequence function. Only matters when both columns are
     * null (none today, but keeping the fallback in case of legacy rows).
     */
    enrolledBy?: string;
  };
};

export type MigrateSequenceToInngestRequested = {
  name: "infra/migrate-sequence-to-inngest.requested";
  data: {
    sequenceId: string;
    enrolledBy?: string;
  };
};

/**
 * Emitted by the Inngest sweep cron once a step_log has been atomically
 * claimed (status='in_flight'). Mirrors the payload Trigger.dev's sweep
 * passes to `sequenceActionExecute.trigger(...)` so both engines drive
 * the shared `runSequenceAction` with the same shape.
 */
export type SequenceActionExecuteRequested = {
  name: "sequence/action.execute.requested";
  data: {
    stepLogId: string;
    enrollmentId: string;
    actionId: string;
    nodeId: string;
    sequenceId: string;
    candidateId?: string;
    contactId?: string;
    enrolledBy: string;
    accountId?: string;
  };
};

/**
 * Pre-schedules every step_log this enrollment will need. Replaces the
 * `tasks.trigger("sequence-enrollment-init", …)` call to Trigger.dev
 * for sequences on the Inngest engine. Trigger.dev's
 * `sequenceEnrollmentInit` task still exists and delegates to the same
 * `runSequenceEnrollmentInit` helper, so legacy callers stay valid.
 */
export type SequenceEnrollmentInitRequested = {
  name: "sequence/enrollment-init.requested";
  data: {
    enrollmentId: string;
    sequenceId: string;
    candidateId?: string;
    contactId?: string;
    enrolledBy: string;
    accountId?: string;
  };
};

/**
 * Fires the engine-neutral RC call-deepgram pipeline (transcribe via
 * Deepgram → extract intel with Joe → write ai_call_notes). Sources:
 *   - poll-rc-calls (Inngest cron) — for newly polled completed calls
 *   - retry-stuck-call-transcripts (Inngest cron) — for missed-recording sweeps
 *   - webhook-ringcentral (Trigger.dev for now) — via the thin
 *     `processCallDeepgram` task that delegates to the same runner
 */
export type CallTranscribeRequested = {
  name: "call/transcribe.requested";
  data: {
    call_log_id?: string;
    batch?: boolean;
    limit?: number;
    dry_run?: boolean;
  };
};

/** One-off RC call-log backfill (e.g. last 24h). */
export type BackfillRcCallsRequested = {
  name: "ops/backfill-rc-calls.requested";
  data: {
    lookback_minutes?: number;
  };
};

/**
 * Inbound RingCentral webhook payload, fanned in by
 * `api/webhooks/ringcentral.ts`. The Inngest handler at
 * `api/lib/inngest/functions/process-ringcentral-event.ts` does the
 * matching, logging, and chained transcription dispatch.
 */
export type WebhookRingcentralReceived = {
  name: "webhooks/ringcentral.received";
  data: {
    body: any;
    headers: Record<string, string | string[] | undefined>;
    receivedAt: string;
  };
};

/**
 * Inbound Unipile webhook payload, fanned in by `api/webhooks/unipile.ts`.
 * Handles LinkedIn messages, connection updates, and (Phase 3) Outlook
 * email events.
 */
export type WebhookUnipileReceived = {
  name: "webhooks/unipile.received";
  data: {
    body: {
      event?: string;
      type?: string;
      data?: any;
      message?: any;
      conversation?: any;
      connection?: any;
    };
    receivedAt: string;
    verified?: boolean;
  };
};

/**
 * Inbound Microsoft Graph webhook notification (one per `value[]` entry,
 * fanned out by `api/webhooks/microsoft-graph.ts`). Drives email +
 * calendar handling for the emeraldrecruit.com tenant.
 */
export type WebhookMicrosoftReceived = {
  name: "webhooks/microsoft.received";
  data: {
    notification: {
      subscriptionId?: string;
      changeType?: string;
      resource?: string;
      resourceData?: any;
      clientState?: string;
      tenantId?: string;
    };
    receivedAt: string;
    verified?: boolean | null;
  };
};

/**
 * Triggers the Joe Says brief regeneration for a candidate or contact.
 * Sent after any inbound communication or resume ingestion completes
 * so the recruiter-facing summary stays fresh.
 */
export type JoeSaysRequested = {
  name: "ai/joe-says.requested";
  data: {
    entityId: string;
    entityType: "candidate" | "contact";
  };
};

/**
 * Triggers parsing + embedding for a freshly uploaded resume.
 */
export type ResumeIngestionRequested = {
  name: "ai/resume-ingestion.requested";
  data: {
    resumeId: string;
    candidateId: string;
    filePath: string;
    fileName: string;
  };
};

export type AllInngestEvents =
  | BulkMigrateSequencesRequested
  | MigrateSequenceToInngestRequested
  | SequenceActionExecuteRequested
  | SequenceEnrollmentInitRequested
  | CallTranscribeRequested
  | BackfillRcCallsRequested
  | WebhookRingcentralReceived
  | WebhookUnipileReceived
  | WebhookMicrosoftReceived
  | JoeSaysRequested
  | ResumeIngestionRequested;
