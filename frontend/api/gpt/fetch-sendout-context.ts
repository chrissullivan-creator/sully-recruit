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
          .select("id, file_name, file_path, raw_text, ai_summary, parsed_json, mime_type, parsing_status, created_at")
          .eq("candidate_id", candidate_id)
          .order("created_at", { ascending: false })
          .limit(5),
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
    const resumeRows: any[] = (resumeRes.data ?? []) as any[];

    // Generate short-lived signed URLs for each resume PDF in Storage so the
    // GPT (or its code interpreter) can fetch the real document when the
    // parsed text turns out to be just the header (the parser commonly stores
    // a structured JSON blob in raw_text rather than the full PDF body).
    const resumes = await Promise.all(
      resumeRows.map(async (r: any) => {
        let signed_url: string | null = null;
        if (r.file_path) {
          try {
            const { data: signed } = await supabase.storage
              .from("resumes")
              .createSignedUrl(r.file_path, 3600);
            signed_url = signed?.signedUrl ?? null;
          } catch {
            // Best-effort — bucket misconfiguration shouldn't kill the response.
          }
        }
        return {
          resume_id: r.id,
          file_name: r.file_name ?? null,
          mime_type: r.mime_type ?? null,
          parsing_status: r.parsing_status ?? null,
          raw_text: r.raw_text ?? null,
          ai_summary: r.ai_summary ?? null,
          parsed_json: r.parsed_json ?? null,
          signed_url,
          created_at: r.created_at,
        };
      }),
    );
    const resume = resumes[0] ?? null;

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
      // `latest_resume` keeps back-compat with the original schema (single
      // most-recent resume). `resumes` is the new array surface — up to 5
      // recent versions, each with a 1-hour signed Storage URL so the GPT
      // can fetch the actual PDF if raw_text turns out to be the
      // parser's structured-JSON blob instead of the document body.
      latest_resume: resume,
      resumes,
      resume_parser_note:
        resumes.length === 0
          ? "No resume rows found for this candidate."
          : "Note: resumes.raw_text often contains the parser's structured JSON header (name/skills/current_title), not the full PDF body. If you need the actual work history, use `signed_url` on each resume to download the PDF and read it via your code interpreter.",
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
        company: job.company_name || null,
        location: job.location || null,
        compensation: job.compensation || null,
        status: job.status || null,
        description: job.description || null,
        additional_notes: job.additional_notes || null,
        submittal_instructions: job.submittal_instructions || null,
        job_url: job.job_url || null,
        num_openings: job.num_openings ?? null,
      },
      existing_send_out_id: sendOutRes.data?.id ?? null,
      existing_send_out_stage: sendOutRes.data?.stage ?? null,
    });
  } catch (err: any) {
    console.error("gpt/fetch-sendout-context error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
