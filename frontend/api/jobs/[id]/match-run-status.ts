import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../../lib/auth";

/**
 * GET /api/jobs/[id]/match-run-status?runId=xxx
 * Returns the status of a matching run so the UI can poll for completion.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  const runId = req.query.runId as string;
  if (!runId) {
    return res.status(400).json({ error: "Missing runId" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data, error } = await supabase
    .from("job_match_runs")
    .select("status, matches_found, error_message")
    .eq("id", runId)
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json(data);
}
