import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/gpt/fetch-sendout-context
 *
 * Bundles the full context the Ask Joe Send-Out GPT needs to write a
 * candidate-intro blurb and reformat the resume for a specific role:
 *   - candidate profile
 *   - latest parsed resume text
 *   - structured call intel (ai_call_notes) + manual notes
 *   - job description (title, company, salary, notes)
 *   - existing send_out row id, if the pairing already exists
 *
 * Body: { candidate_id: string, job_id: string }
 * Auth: SUPABASE_SERVICE_ROLE_KEY bearer or Supabase user JWT.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireAuth(req, res))) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { candidate_id, job_id } = req.body ?? {};
    if (!candidate_id || typeof candidate_id !== "string") {
      return res.status(400).json({ error: "Missing required field: candidate_id" });
    }
    if (!job_id || typeof job_id !== "string") {
      return res.status(400).json({ error: "Missing required field: job_id" });
    }

    const [candidateRes, resumeRes, aiNotesRes, manualNotesRes, callLogsRes, jobRes, sendOutRes] =
      await Promise.all([
        supabase
          .from("candidates")
          .select("*")
          .eq("id", candidate_id)
          .maybeSingle(),
        supabase
          .from("resumes")
          .select("id, file_name, raw_text, ai_summary, parsed_json, created_at")
          .eq("candidate_id", candidate_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("ai_call_notes")
          .select("id, summary, action_items, sentiment, created_at, call_log_id")
          .eq("candidate_id", candidate_id)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("notes")
          .select("id, note, created_at, created_by")
          .eq("entity_type", "candidate")
          .eq("entity_id", candidate_id)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("call_logs")
          .select("id, summary, notes, started_at, duration_seconds")
          .eq("linked_entity_type", "candidate")
          .eq("linked_entity_id", candidate_id)
          .order("started_at", { ascending: false })
          .limit(10),
        supabase
          .from("jobs")
          .select("*")
          .eq("id", job_id)
          .maybeSingle(),
        supabase
          .from("send_outs")
          .select("id, stage, sent_to_client_at, submission_blurb")
          .eq("candidate_id", candidate_id)
          .eq("job_id", job_id)
          .limit(1)
          .maybeSingle(),
      ]);

    if (candidateRes.error) return res.status(500).json({ error: `candidate: ${candidateRes.error.message}` });
    if (!candidateRes.data)  return res.status(404).json({ error: "candidate not found" });
    if (jobRes.error)        return res.status(500).json({ error: `job: ${jobRes.error.message}` });
    if (!jobRes.data)        return res.status(404).json({ error: "job not found" });

    const cand: any = candidateRes.data;
    const job: any = jobRes.data;
    const resume: any = resumeRes.data;

    return res.status(200).json({
      candidate: {
        candidate_id: cand.id,
        full_name: `${cand.first_name ?? ""} ${cand.last_name ?? ""}`.trim(),
        first_name: cand.first_name ?? null,
        last_name: cand.last_name ?? null,
        email: cand.primary_email || cand.email || cand.personal_email || null,
        phone: cand.phone || cand.mobile_phone || null,
        current_title: cand.current_title || null,
        current_company: cand.current_company || null,
        location: cand.location_text ?? null,
        linkedin_url: cand.linkedin_url || null,
        linkedin_headline: cand.linkedin_headline || null,
        skills: cand.skills ?? [],
        target_roles: cand.target_roles ?? null,
        target_locations: cand.target_locations ?? null,
        current_base_comp: cand.current_base_comp ?? null,
        current_bonus_comp: cand.current_bonus_comp ?? null,
        current_total_comp: cand.current_total_comp ?? null,
        target_base_comp: cand.target_base_comp ?? null,
        target_bonus_comp: cand.target_bonus_comp ?? null,
        target_total_comp: cand.target_total_comp ?? null,
        comp_notes: cand.comp_notes ?? null,
        work_authorization: cand.work_authorization ?? null,
        visa_status: cand.visa_status ?? null,
        notice_period: cand.notice_period ?? null,
        reason_for_leaving: cand.reason_for_leaving ?? null,
        notes: cand.notes ?? null,
        candidate_summary: cand.candidate_summary ?? null,
        where_interviewed: cand.where_interviewed ?? null,
        where_submitted: cand.where_submitted ?? null,
      },
      latest_resume: resume
        ? {
            resume_id: resume.id,
            file_name: resume.file_name ?? null,
            raw_text: resume.raw_text ?? null,
            ai_summary: resume.ai_summary ?? null,
            parsed_json: resume.parsed_json ?? null,
            created_at: resume.created_at,
          }
        : null,
      ai_call_notes: (aiNotesRes.data ?? []).map((n: any) => ({
        id: n.id,
        summary: n.summary,
        action_items: n.action_items,
        sentiment: n.sentiment,
        created_at: n.created_at,
        call_log_id: n.call_log_id,
      })),
      call_logs: (callLogsRes.data ?? []).map((c: any) => ({
        id: c.id,
        summary: c.summary,
        notes: c.notes,
        started_at: c.started_at,
        duration_seconds: c.duration_seconds,
      })),
      manual_notes: (manualNotesRes.data ?? []).map((n: any) => ({
        id: n.id,
        note: n.note,
        created_at: n.created_at,
      })),
      job: {
        job_id: job.id,
        title: job.title,
        company: job.company || null,
        location: job.location || null,
        salary: job.salary || null,
        stage: job.stage || null,
        priority: job.priority || null,
        hiring_manager: job.hiring_manager || null,
        notes: job.notes || null,
      },
      existing_send_out_id: sendOutRes.data?.id ?? null,
      existing_send_out_stage: sendOutRes.data?.stage ?? null,
    });
  } catch (err: any) {
    console.error("gpt/fetch-sendout-context error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
