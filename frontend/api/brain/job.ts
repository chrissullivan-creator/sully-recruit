import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/job
 *
 * Full job detail plus a roll-up of send-outs against it, grouped by stage,
 * and the most recent candidates in the pipeline.
 *
 * Body: { job_id: string }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const jobId = String(req.body?.job_id ?? "").trim();
  if (!jobId) return res.status(400).json({ error: "job_id required" });

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const [jobRes, sendOutsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, title, company_name, location, status, compensation, description, submittal_instructions, additional_notes, job_url, job_code, num_openings, contact_id, created_at, updated_at, last_sourced_at",
      )
      .eq("id", jobId)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("send_outs")
      .select(
        "id, stage, outcome, candidate_id, candidates:candidate_id(full_name, current_title, current_company), sent_to_client_at, interview_at, offer_at, placed_at, updated_at, feedback, rejection_reason",
      )
      .eq("job_id", jobId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);

  if (jobRes.error) return res.status(500).json({ error: jobRes.error.message });
  if (!jobRes.data) return res.status(404).json({ error: "job not found", job_id: jobId });

  const job: any = { ...jobRes.data };
  if (typeof job.description === "string") job.description = job.description.slice(0, 4000);
  if (typeof job.additional_notes === "string") job.additional_notes = job.additional_notes.slice(0, 2000);

  const sendOuts = (sendOutsRes.data as any[]) ?? [];
  const byStage: Record<string, number> = {};
  for (const s of sendOuts) {
    const k = s.stage ?? "unknown";
    byStage[k] = (byStage[k] ?? 0) + 1;
  }

  return res.status(200).json({
    job,
    send_outs_count: sendOuts.length,
    send_outs_by_stage: byStage,
    recent_send_outs: sendOuts.slice(0, 15).map((s) => ({
      id: s.id,
      stage: s.stage,
      outcome: s.outcome,
      candidate_id: s.candidate_id,
      candidate_name: s.candidates?.full_name ?? null,
      candidate_title: s.candidates?.current_title ?? null,
      candidate_company: s.candidates?.current_company ?? null,
      sent_to_client_at: s.sent_to_client_at,
      interview_at: s.interview_at,
      offer_at: s.offer_at,
      placed_at: s.placed_at,
      updated_at: s.updated_at,
      feedback: s.feedback ? String(s.feedback).slice(0, 400) : null,
      rejection_reason: s.rejection_reason,
    })),
  });
}
