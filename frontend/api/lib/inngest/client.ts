import { Inngest } from "inngest";

/**
 * Phase 1 of the Trigger.dev → Inngest cutover. The client is single-tenant —
 * all Sully background work goes through this id. Event keys are per-event-source
 * (we currently have one: the manually-fired `infra/bulk-migrate-sequences.requested`).
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

export type SequenceRunRequested = {
  name: "sequence/run.requested";
  data: {
    enrollmentId: string;
    sequenceId: string;
    enrolledBy: string;
  };
};

export type AllInngestEvents =
  | BulkMigrateSequencesRequested
  | MigrateSequenceToInngestRequested
  | SequenceRunRequested;
