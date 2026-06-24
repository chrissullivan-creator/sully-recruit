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
  if ((body.type !== "INSERT" && body.type !== "UPDATE") || body.table !== "people") {
    return res.status(200).json({ skipped: true, reason: "not a people INSERT/UPDATE" });
  }

  const record = body.record ?? {};
  const oldRecord = body.old_record ?? null;
  const entityId = record.id as string | undefined;
  if (!entityId) {
    return res.status(200).json({ skipped: true, reason: "no record.id" });
  }

  // Skip placeholder stubs — resume-ingestion fires the UPDATE-side
  // webhook itself once is_stub flips to false on parse completion.
  if (record.is_stub === true) {
    return res.status(200).json({ skipped: true, reason: "is_stub" });
  }

  // On UPDATE, only proceed for the two meaningful transitions the
  // Postgres trigger fires for — the DB side already filters, but
  // double-check here so a webhook replay can't reprocess unchanged rows.
  if (body.type === "UPDATE" && oldRecord) {
    const stubResolved =
      oldRecord.is_stub === true && record.is_stub === false;
    const linkedinJustAdded =
      (!oldRecord.linkedin_url || oldRecord.linkedin_url === "") &&
      !!record.linkedin_url;
    if (!stubResolved && !linkedinJustAdded) {
      return res.status(200).json({ skipped: true, reason: "no relevant transition" });
    }
  }

  const hasEmail = !!(record.primary_email || record.work_email || record.personal_email);
  const hasLinkedin = !!record.linkedin_url;

  const entityType: "candidate" | "contact" = record.type === "client" ? "contact" : "candidate";

  // No LinkedIn URL? Queue a search by name + current_company. The
  // find-linkedin-url-by-name function writes the URL back on a
  // confident match, which re-fires this webhook via the
  // linkedin_url-just-added branch of notify_person_created. Cheap to
  // dispatch — function exits fast on already-has-url / no-name.
  let searchDispatched = false;
  if (!hasLinkedin) {
    try {
      await inngest.send({
        name: "people/find-linkedin-url.requested",
        data: { person_id: entityId },
      });
      searchDispatched = true;
    } catch (err: any) {
      console.warn("find-linkedin-url dispatch failed", err?.message);
    }
  }

  // Need at least one of email or LinkedIn to do anything else; if we
  // also have no name to search on, the row is unactionable for now.
  if (!hasEmail && !hasLinkedin) {
    return res.status(200).json({
      skipped: true,
      reason: "no email or linkedin",
      search_dispatched: searchDispatched,
    });
  }

  // Eagerly resolve the person's Unipile provider_id when we have a LinkedIn
  // URL, so it's cached long before they're ever enrolled in a sequence — the
  // connection step then hits that cache instead of doing the first cold
  // lookup itself under a batch burst (which tripped Unipile's 1-req/sec cap).
  // Routed through the resolve-person-on-demand Inngest function, which is
  // concurrency-limited to 1 and daily-budget-aware: a bulk add resolves
  // serially instead of firing N concurrent lookups, and anything it can't
  // reach today stays `pending` for the daily cron.
  let resolveDispatched = false;
  if (hasLinkedin) {
    try {
      await inngest.send({
        // De-dupe a flurry of INSERT/UPDATE webhooks for the same person
        // within the hour into a single resolve.
        id: `resolve-unipile-${entityId}-${Math.floor(Date.now() / 3_600_000)}`,
        name: "people/resolve-unipile.requested",
        data: { person_id: entityId },
      });
      resolveDispatched = true;
    } catch (err: any) {
      console.warn("resolve-unipile dispatch failed", err?.message);
    }
  }

  try {
    const { ids } = await inngest.send({
      // Same id shape the hourly cron uses — keeps Inngest's dedup
      // window consistent if the cron also picks this row up before
      // last_history_synced_at is stamped.
      id: `entity-history-${entityId}-${Math.floor(Date.now() / 3_600_000)}`,
      name: "messages/fetch-entity-history.requested",
      data: { entity_id: entityId, entity_type: entityType },
    });
    return res.status(200).json({
      dispatched: true,
      eventId: ids[0],
      entity_type: entityType,
      resolve_dispatched: resolveDispatched,
      search_dispatched: searchDispatched,
      op: body.type,
    });
  } catch (err: any) {
    console.error("person-created webhook error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
