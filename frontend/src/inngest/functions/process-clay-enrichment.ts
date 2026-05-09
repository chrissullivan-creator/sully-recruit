import { inngest } from "../client";

/**
 * Stub for Clay enrichment webhook events.
 *
 * The Trigger.dev model fired `tasks.trigger("process-clay-enrichment")`
 * but that task wasn't actually defined in this codebase — the real
 * Clay enrichment work is handled by the Supabase edge function
 * `clay-webhook` (deployed separately). The webhook receiver just
 * needed an "ack queue" for retries.
 *
 * This Inngest function preserves that ack-queue contract: receives
 * the event, logs it, and exits. If/when the real processing logic
 * gets added to this codebase (vs the edge function), it slots in
 * here.
 */
export const processClayEnrichment = inngest.createFunction(
  {
    id: "process-clay-enrichment",
    retries: 1,
    triggers: [{ event: "clay/enrichment-received" }],
  },
  async ({ event, logger }) => {
    logger.info("Clay enrichment event received (handled by clay-webhook edge function)", {
      receivedAt: (event.data as any)?.receivedAt,
      hasBody: !!(event.data as any)?.body,
    });
    return { skipped: true, reason: "handled_by_edge_function" };
  },
);
