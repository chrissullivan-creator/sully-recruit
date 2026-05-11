import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../lib/inngest/client.js";

/**
 * Vercel serverless function — Supabase database webhook receiver for
 * `people` INSERT events. Fires `messages/fetch-entity-history.requested`
 * so a brand-new candidate / client gets their email + LinkedIn history
 * pulled within seconds of being added, instead of waiting up to an hour
 * for the `backfill-entity-histories` cron to find them.
 *
 * Auth: shared bearer secret in `Authorization: Bearer <secret>`. The
 * value lives in two places:
 *   - app_settings.PERSON_CREATED_WEBHOOK_SECRET (read by the Postgres
 *     trigger that fires the webhook — see migration 20260511030000)
 *   - PERSON_CREATED_WEBHOOK_SECRET env var on Vercel (read here)
 * Both must match.
 *
 * Payload shape: Supabase's database-webhook envelope —
 *   { type: "INSERT", table: "people", schema: "public",
 *     record: { id, type, primary_email, ..., is_stub }, ... }
 *
 * Pre-flight skips: rows with is_stub=true (placeholder pending resume
 * parse; the parser will fire its own event when it resolves the real
 * identity), and rows with no contact info at all.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.PERSON_CREATED_WEBHOOK_SECRET || "";
  if (!expected) {
    // Secret not configured — return 500 so the failure is visible in
    // pg_net's response log instead of silently accepting unauth'd calls.
    return res.status(500).json({ error: "PERSON_CREATED_WEBHOOK_SECRET not configured" });
  }
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body ?? {};
  if (body.type !== "INSERT" || body.table !== "people") {
    return res.status(200).json({ skipped: true, reason: "not a people INSERT" });
  }

  const record = body.record ?? {};
  const entityId = record.id as string | undefined;
  if (!entityId) {
    return res.status(200).json({ skipped: true, reason: "no record.id" });
  }

  // Skip placeholder stubs — resume-ingestion fires its own event for
  // the real candidate once the parse resolves identity.
  if (record.is_stub === true) {
    return res.status(200).json({ skipped: true, reason: "is_stub" });
  }

  // Skip if there's no contact info to fetch against.
  const hasEmail = !!(record.primary_email || record.work_email || record.personal_email);
  const hasLinkedin = !!record.linkedin_url;
  if (!hasEmail && !hasLinkedin) {
    return res.status(200).json({ skipped: true, reason: "no email or linkedin" });
  }

  const entityType: "candidate" | "contact" = record.type === "client" ? "contact" : "candidate";

  try {
    const { ids } = await inngest.send({
      // Same id shape the hourly cron uses — keeps Inngest's dedup
      // window consistent if the cron also picks this row up before
      // last_history_synced_at is stamped.
      id: `entity-history-${entityId}-${Math.floor(Date.now() / 3_600_000)}`,
      name: "messages/fetch-entity-history.requested",
      data: { entity_id: entityId, entity_type: entityType },
    });
    return res.status(200).json({ dispatched: true, eventId: ids[0], entity_type: entityType });
  } catch (err: any) {
    console.error("person-created webhook error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
