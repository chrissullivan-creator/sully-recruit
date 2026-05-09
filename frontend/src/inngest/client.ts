import { Inngest } from "inngest";

/**
 * Sully Recruit Inngest client.
 *
 * Inngest v4 changed how event types are declared — `EventSchemas` is
 * gone; per-trigger typing now comes from the `eventType` factory at
 * the function definition site. As more functions migrate off
 * Trigger.dev, each will declare its own event types inline using
 * `eventType<{...}>("event/name")`. Keeping the client itself untyped
 * for now — Phase 1 focuses on getting the foundation wired up.
 *
 * Events are namespaced "<domain>/<verb>" (e.g. "sequence/enrolled",
 * "joe/says-requested") so logs and replays in the dashboard read
 * coherently.
 */
export const inngest = new Inngest({
  id: "sully-recruit",
});
