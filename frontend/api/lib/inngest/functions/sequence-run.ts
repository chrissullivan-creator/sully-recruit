import { inngest } from "../client.js";

/**
 * Per-enrollment runner. Phase 1: NO-OP placeholder so the wiring is
 * deployable end-to-end. Receiving a `sequence/run.requested` here today
 * just acknowledges it — no sends, no DB writes — because no sequence is on
 * `engine='inngest'` yet.
 *
 * Phase 2 implementation outline (filled in by the next PR):
 *   1. `load-context`             fetch enrollment + sequence + remaining
 *                                 sequence_actions in node order
 *   2. for each action:
 *      a. `step.sleepUntil`       computed scheduled_at via
 *                                 send-time-calculator.calculateSendTime
 *      b. `check-stopped`         re-read enrollment status, bail if
 *                                 stopped/paused/replied
 *      c. `send`                  call sendEmail / sendSms / sendLinkedIn
 *                                 (existing modules in
 *                                 trigger/lib/send-channels.ts)
 *      d. `record-log`            INSERT sequence_step_logs row with
 *                                 status='sent'
 *      e. on `pending_connection` → return; webhook resumes via
 *         `sequence/run.resume` event
 *   3. `mark-complete`            UPDATE sequence_enrollments
 *                                 SET status='completed' when no more actions
 */
export const sequenceRun = inngest.createFunction(
  { id: "sequence-run", name: "Run one enrollment to completion" },
  { event: "sequence/run.requested" },
  async ({ event, logger }) => {
    logger.info("Phase 1 — no-op sequence-run", {
      enrollmentId: event.data.enrollmentId,
      sequenceId: event.data.sequenceId,
    });
    return { action: "phase1_noop", enrollmentId: event.data.enrollmentId };
  },
);
