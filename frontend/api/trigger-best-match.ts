import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";

/**
 * Vercel serverless function to trigger the best-match-job Trigger.dev task.
 * Creates a run record, then dispatches the background task.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: "Missing required field: jobId" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    // Create a run record so the UI can track progress
    const runId = crypto.randomUUID();
    await supabase.from("job_match_runs").insert({
      id: runId,
      job_id: jobId,
      status: "running",
    });

    const handle = await tasks.trigger("best-match-job", { jobId, runId });

    return res.status(200).json({ triggered: true, runId, id: handle.id });
  } catch (err: any) {
    console.error("Trigger best-match error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
