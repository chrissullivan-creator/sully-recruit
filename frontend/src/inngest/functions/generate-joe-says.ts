import { inngest } from "../client";
import { runGenerateJoeSays } from "../../trigger/generate-joe-says";

/**
 * Inngest port of the Joe Says brief generator.
 *
 * Single source of truth for the logic lives in
 * frontend/src/trigger/generate-joe-says.ts as `runGenerateJoeSays`.
 * This function is the Inngest shell — same behaviour, different
 * orchestration. The Trigger.dev task there stays for legacy callers
 * (other Trigger.dev tasks chain into it) until Phase 5b.
 *
 * Triggered by `joe/says-requested` events from:
 *   - /api/trigger-generate-joe-says
 *   - the new sequence-run function after each outbound send
 *   - inbound webhook handlers (Phase 4c)
 */
export const generateJoeSays = inngest.createFunction(
  {
    id: "generate-joe-says",
    retries: 2,
    triggers: [{ event: "joe/says-requested" }],
    concurrency: [
      // One brief generation per (entityId, entityType) at a time.
      // A burst of inbound replies on a single candidate would
      // otherwise queue 5 redundant Joe Says runs back-to-back.
      { key: "event.data.entityId", limit: 1 },
    ],
  },
  async ({ event, step, logger }) => {
    const { entityId, entityType } = event.data as {
      entityId: string;
      entityType: "candidate" | "contact";
    };
    if (!entityId || !entityType) {
      return { skipped: true, reason: "missing_entity_fields" };
    }
    return step.run("run", () =>
      runGenerateJoeSays({ entityId, entityType }, logger),
    );
  },
);
