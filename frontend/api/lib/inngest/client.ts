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

export type AllInngestEvents =
  | BulkMigrateSequencesRequested
  | MigrateSequenceToInngestRequested
  | SequenceActionExecuteRequested;
