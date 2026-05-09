import { inngest } from "../client";
import { getSupabaseAdmin } from "../../server/lib/supabase";

/**
 * Reply → cancel relay.
 *
 * The Trigger.dev sequence engine relied on a Postgres trigger
 * (`stop_enrollments_on_reply()`) to flip enrollment.status='stopped'
 * the moment an inbound `messages` row landed. The Trigger.dev
 * action-execute task then re-checked enrollment.status before each
 * send and bailed if not active.
 *
 * The Inngest sequence-run function takes a different approach:
 * cancelOn at the function definition. Once a `sequence/cancel` event
 * arrives matching the enrollmentId, Inngest aborts the function and
 * any unstarted step.run / step.sleepUntil / step.waitForEvent calls
 * never fire.
 *
 * This relay sits between the webhook (which emits
 * `message/inbound-reply`) and the sequence functions. It looks up
 * every active enrollment for the inbound sender and dispatches one
 * `sequence/cancel` event per match. The DB trigger continues firing
 * in parallel for the legacy Trigger.dev enrollments — both paths are
 * idempotent (already-stopped rows no-op on the cancel).
 *
 * Connection-accepted events bypass this relay and route to
 * `linkedin/connection-accepted` directly so sequence-run can
 * `step.waitForEvent` past the connection gate without aborting.
 */
export const cancelOnReply = inngest.createFunction(
  {
    id: "cancel-on-reply",
    name: "Cancel sequences on inbound reply",
    retries: 1,
    triggers: [{ event: "message/inbound-reply" }],
  },
  async ({ event, step, logger }) => {
    const { candidateId, contactId, channel, replyText } = event.data as {
      candidateId?: string;
      contactId?: string;
      channel: string;
      replyText?: string;
    };

    if (!candidateId && !contactId) {
      return { action: "skipped", reason: "no_entity_id" };
    }

    const supabase = getSupabaseAdmin();

    const enrollments = await step.run("find-active-enrollments", async () => {
      const col = candidateId ? "candidate_id" : "contact_id";
      const id = candidateId || contactId;
      const { data } = await supabase
        .from("sequence_enrollments")
        .select("id, sequence_id")
        .eq(col, id!)
        .eq("status", "active");
      return data ?? [];
    });

    if (enrollments.length === 0) {
      return { action: "skipped", reason: "no_active_enrollments" };
    }

    // Fan out one cancel event per enrollment. inngest.send is
    // idempotent in the sense that a sequence-run that's already
    // cancelled (or already completed) silently no-ops on the cancel.
    await step.run("dispatch-cancels", async () => {
      await inngest.send(
        enrollments.map((e: any) => ({
          name: "sequence/cancel",
          data: {
            enrollmentId: e.id,
            sequenceId: e.sequence_id,
            reason: "reply_received",
            channel,
            preview: (replyText || "").slice(0, 200),
          },
        })),
      );
    });

    logger.info("Dispatched sequence/cancel for inbound reply", {
      candidateId, contactId, channel,
      enrollmentCount: enrollments.length,
    });

    return {
      action: "cancelled",
      enrollmentIds: enrollments.map((e: any) => e.id),
    };
  },
);
