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
  if (!hasEmail && !hasLinkedin) {
    return res.status(200).json({ skipped: true, reason: "no email or linkedin" });
  }

  const entityType: "candidate" | "contact" = record.type === "client" ? "contact" : "candidate";

  // Eagerly resolve the person's Unipile provider_id when we have a
  // LinkedIn URL — without it, fetch-entity-history's LinkedIn leg has
  // nothing to match against. Fire-and-forget on the same host so we
  // don't block the trigger response. resolve-person-now is idempotent
  // and 200s on every error, so a failure here just falls back to the
  // every-2h cron sweep.
  let resolveDispatched = false;
  if (hasLinkedin) {
    try {
      const host = (req.headers["x-forwarded-host"] || req.headers.host) as string | undefined;
      const proto = (req.headers["x-forwarded-proto"] as string) || "https";
      const base = host ? `${proto}://${host}` : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
      if (base) {
        // Don't await — resolve-person-now hits Unipile and can take a
        // few seconds; the trigger doesn't need the result.
        void fetch(`${base}/api/resolve-person-now`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ person_id: entityId }),
        }).catch((err) => {
          console.warn("resolve-person-now fire-and-forget failed", err?.message);
        });
        resolveDispatched = true;
      }
    } catch (err: any) {
      console.warn("resolve-person-now dispatch threw", err?.message);
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
      op: body.type,
    });
  } catch (err: any) {
    console.error("person-created webhook error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
