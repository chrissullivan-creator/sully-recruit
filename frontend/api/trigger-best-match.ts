import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";
import { inngest } from "./lib/inngest/client.js";

/**
 * POST /api/trigger-best-match
 *
 * Body: { jobId | job_id }
 *
 * Kicks off an AI candidate→job matching run for the given job. Inserts a
 * `job_match_runs` row (the UI polls its status via
 * /api/jobs/[id]/match-run-status), fires the `job/best-match.requested`
 * Inngest event, and returns the run id so the client can poll.
 *
 * NOTE: the `job_match_runs.status` CHECK constraint only allows
 * 'running' | 'completed' | 'failed' — so the row starts as 'running'
 * (not 'queued'); the Inngest worker flips it to 'completed'/'failed'.
 *
 * Auth: standard Supabase JWT (or service-role key) — see api/lib/auth.ts.
 * Returns: { runId }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already sent

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const jobId: string = String(req.body?.jobId ?? req.body?.job_id ?? "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "Missing required field: jobId" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Make sure the job exists (and isn't trashed) before spinning up a run.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id")
    .eq("id", jobId)
    .is("deleted_at", null)
    .maybeSingle();
  if (jobErr) {
    return res.status(500).json({ error: `Failed to load job: ${jobErr.message}` });
  }
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // Insert the run row. 'running' is the only valid "in progress" status the
  // CHECK constraint permits — the UI just polls until completed/failed.
  const { data: run, error: runErr } = await supabase
    .from("job_match_runs")
    .insert({ job_id: jobId, status: "running" } as any)
    .select("id")
    .single();

  if (runErr || !run) {
    return res.status(500).json({ error: `Failed to create match run: ${runErr?.message ?? "unknown"}` });
  }

  try {
    await inngest.send({
      name: "job/best-match.requested",
      data: { runId: run.id, jobId },
    });
  } catch (err: any) {
    // Couldn't enqueue — mark the run failed so the poller doesn't hang.
    await supabase
      .from("job_match_runs")
      .update({ status: "failed", error_message: `enqueue failed: ${err?.message ?? "unknown"}`, completed_at: new Date().toISOString() } as any)
      .eq("id", run.id);
    return res.status(500).json({ error: `Failed to enqueue match run: ${err?.message ?? "unknown"}` });
  }

  return res.status(200).json({ runId: run.id, status: "running" });
}
