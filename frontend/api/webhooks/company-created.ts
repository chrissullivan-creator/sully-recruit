import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../lib/inngest/client.js";

/**
 * Supabase database webhook receiver for `companies` INSERT events.
 * Fires `companies/enrich-via-apollo.requested` so a brand-new company
 * gets enriched within seconds of being added, instead of waiting up
 * to an hour for the `enrich-companies-sweep` cron.
 *
 * Auth + payload shape mirror person-created.ts. Secret lives in
 * app_settings.COMPANY_CREATED_WEBHOOK_SECRET (read by the Postgres
 * trigger) and Vercel env COMPANY_CREATED_WEBHOOK_SECRET (read here).
 * Both must match.
 *
 * Pre-flight skip: rows without a `domain` (Apollo enrichment needs one
 * to be useful — name-only matching is too lossy for B2B).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.COMPANY_CREATED_WEBHOOK_SECRET || "";
  if (!expected) {
    return res.status(500).json({ error: "COMPANY_CREATED_WEBHOOK_SECRET not configured" });
  }
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body ?? {};
  if (body.type !== "INSERT" || body.table !== "companies") {
    return res.status(200).json({ skipped: true, reason: "not a companies INSERT" });
  }

  const record = body.record ?? {};
  const companyId = record.id as string | undefined;
  if (!companyId) {
    return res.status(200).json({ skipped: true, reason: "no record.id" });
  }

  // Apollo enrichment needs a domain to be useful. Skip if we don't
  // have one — the sweep cron will still pick it up later if a domain
  // gets backfilled, since the row's apollo_company_status starts NULL.
  const domain = (record.domain || "").trim();
  if (!domain) {
    return res.status(200).json({ skipped: true, reason: "no domain" });
  }

  try {
    const { ids } = await inngest.send({
      // Hour-bucketed id so retry waves don't collide with the
      // per-company concurrency cap inside enrich-company-via-apollo.
      id: `enrich-company-${companyId}-${Math.floor(Date.now() / 3_600_000)}`,
      name: "companies/enrich-via-apollo.requested",
      data: { company_id: companyId },
    });
    return res.status(200).json({ dispatched: true, eventId: ids[0] });
  } catch (err: any) {
    console.error("company-created webhook error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
