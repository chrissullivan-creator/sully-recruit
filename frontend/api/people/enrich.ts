import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import {
  runEnrichmentForPeople,
  type EnrichField,
} from "../lib/enrichment-runner.js";
import { inngest } from "../lib/inngest/client.js";

/**
 * POST /api/people/enrich
 *
 * Two paths based on batch size:
 *   - peopleIds.length ≤ SYNC_THRESHOLD → run the cascade inline, return
 *     full results. Fast feedback for the single-person UI case.
 *   - peopleIds.length >  SYNC_THRESHOLD → create an enrichment_jobs row,
 *     fire `enrichment/run.requested` for the Inngest worker, return
 *     `{ queued: true, jobId }`. The worker processes in chunks of 10
 *     and stamps the job row as it goes — the EnrichButton polls
 *     /api/enrichment-jobs/{id} to surface progress.
 *
 * The cascade itself lives in api/lib/enrichment-runner.ts so both
 * paths share the exact same code. See that file for per-field
 * provider order and verification logic.
 */

const SYNC_THRESHOLD = 5;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  let userId: string | null = null;
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
    userId = user.id;
  }

  const peopleIds: string[] = Array.isArray(req.body?.peopleIds) ? req.body.peopleIds : [];
  const fields: EnrichField[] = Array.isArray(req.body?.fields) ? req.body.fields : ["work_email"];
  if (peopleIds.length === 0) return res.status(400).json({ error: "peopleIds[] required" });
  if (peopleIds.length > 1000) return res.status(400).json({ error: "Max 1000 per request" });
  if (fields.length === 0) return res.status(400).json({ error: "fields[] required" });

  // ── ASYNC PATH ─────────────────────────────────────────────────
  // Large batches go through Inngest. Vercel's 60s timeout cannot
  // accommodate FullEnrich + BetterContact polling for 10+ people.
  if (peopleIds.length > SYNC_THRESHOLD) {
    const { data: job, error: jobErr } = await supabase
      .from("enrichment_jobs")
      .insert({
        created_by_user_id: userId,
        status: "queued",
        people_ids: peopleIds,
        fields,
        total: peopleIds.length,
      })
      .select("id")
      .single();
    if (jobErr || !job) {
      return res.status(500).json({ error: `job insert failed: ${jobErr?.message ?? "unknown"}` });
    }

    await inngest.send({
      name: "enrichment/run.requested",
      data: { jobId: job.id },
    });

    return res.status(202).json({
      queued: true,
      jobId: job.id,
      total: peopleIds.length,
      message: `Queued ${peopleIds.length} people — poll /api/enrichment-jobs/${job.id} for progress`,
    });
  }

  // ── SYNC PATH ──────────────────────────────────────────────────
  try {
    const { results, credits } = await runEnrichmentForPeople(supabase, peopleIds, fields);
    return res.status(200).json({
      results,
      credits,
      counts: {
        total: peopleIds.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        changed: results.filter((r) => r.updated.length > 0).length,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Enrichment failed" });
  }
}
