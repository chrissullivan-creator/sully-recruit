import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client.js";
import { runSequenceAction } from "../../../../src/server-lib/sequence-runner.js";

/**
 * Inngest mirror of Trigger.dev's `sequenceActionExecute` task. The body
 * is shared via `runSequenceAction` in `src/server-lib/sequence-runner.ts`
 * — same idempotency check, reply guard, send-channels dispatch, re-anchor
 * pass, and message logging the Trigger.dev path runs.
 *
 * `retries: 2` matches Trigger.dev's `maxAttempts: 2` so transient errors
 * have the same retry budget on either engine.
 */
export const sequenceActionExecute = inngest.createFunction(
  {
    id: "sequence-action-execute",
    name: "Execute one sequence action (Inngest)",
    retries: 2,
  },
  { event: "sequence/action.execute.requested" },
  async ({ event, logger }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    return runSequenceAction(supabase, event.data, logger);
  },
);
