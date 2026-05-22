import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireGptAuth, handleCors } from "../lib/gpt-auth.js";

/**
 * GET /api/gpt/submission-context?candidate_id=&job_id=
 *
 * Assembles every approved source-of-truth blob the GPT needs to:
 *   - tailor a resume to a specific job
 *   - draft a recruiter submission write-up
 *
 * Returns:
 *   candidate            : full candidates-view row
 *   job                  : full jobs row
 *   resume               : { raw_text, ai_summary } from most recent resumes row
 *   notes                : free-form notes (notes table, polymorphic)
 *   call_notes           : Ask Joe / call synopses (ai_call_notes table)
 *   existing_submission  : prior submissions row for this pair, or null
 *   usage_rules          : guard rails for the GPT
 *
 * The notes + call_notes are where domain context (products, systems,
 * leadership scope, comp) lives — the GPT must use them as approved
 * source material and NOT invent experience.
 */

// ── Table / column constants (rename if your schema differs) ─────────
const T_CANDIDATES = "candidates";    // view over `people` where type='candidate'
const T_JOBS = "jobs";
const T_NOTES = "notes";              // polymorphic { entity_type, entity_id }
const T_AI_CALL_NOTES = "ai_call_notes";
const T_RESUMES = "resumes";
const T_SUBMISSIONS = "submissions";

const NOTES_LIMIT = 20;
const CALL_NOTES_LIMIT = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireGptAuth(req, res)) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured: Supabase env vars missing" });
  }

  const candidate_id = String(req.query.candidate_id || "").trim();
  const job_id = String(req.query.job_id || "").trim();
  if (!candidate_id) return res.status(400).json({ error: "Missing candidate_id" });
  if (!job_id) return res.status(400).json({ error: "Missing job_id" });

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const [candidateRes, jobRes, resumeRes, notesRes, callNotesRes, subRes] = await Promise.all([
      supabase.from(T_CANDIDATES).select("*").eq("id", candidate_id).maybeSingle(),

      supabase.from(T_JOBS).select("*").eq("id", job_id).maybeSingle(),

      // Most recent resume row — raw_text is the parsed plain-text body
      // we use for resume tailoring. ai_summary is a short LLM blurb.
      supabase
        .from(T_RESUMES)
        .select("id, raw_text, ai_summary, file_url, file_name, source, created_at")
        .eq("candidate_id", candidate_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Free-form notes attached to this candidate (polymorphic table —
      // entity_type='candidate', entity_id=candidate.id).
      supabase
        .from(T_NOTES)
        .select("id, note, created_by, note_source, created_at")
        .eq("entity_type", "candidate")
        .eq("entity_id", candidate_id)
        .order("created_at", { ascending: false })
        .limit(NOTES_LIMIT),

      // Ask Joe / RingCentral call synopses for this candidate.
      supabase
        .from(T_AI_CALL_NOTES)
        .select(
          "id, ai_summary, ai_action_items, extracted_notes, " +
            "extracted_reason_for_leaving, extracted_current_base, " +
            "extracted_current_bonus, extracted_target_base, " +
            "extracted_target_bonus, call_duration_seconds, " +
            "call_started_at, created_at",
        )
        .eq("candidate_id", candidate_id)
        .order("created_at", { ascending: false })
        .limit(CALL_NOTES_LIMIT),

      // Prior submission for this exact (candidate, job) pair, if any.
      supabase
        .from(T_SUBMISSIONS)
        .select("*")
        .eq("candidate_id", candidate_id)
        .eq("job_id", job_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (candidateRes.error) return res.status(500).json({ error: `candidates: ${candidateRes.error.message}` });
    if (jobRes.error) return res.status(500).json({ error: `jobs: ${jobRes.error.message}` });
    if (!candidateRes.data) return res.status(404).json({ error: `candidate ${candidate_id} not found` });
    if (!jobRes.data) return res.status(404).json({ error: `job ${job_id} not found` });

    // Don't bubble service errors for the optional fetches — return what
    // we have. The GPT can still draft from partial context.
    return res.status(200).json({
      candidate: candidateRes.data,
      job: jobRes.data,
      resume: resumeRes?.data ?? null,
      notes: notesRes?.data ?? [],
      call_notes: callNotesRes?.data ?? [],
      existing_submission: subRes?.data ?? null,
      usage_rules: {
        approved_source_material: [
          "candidate fields (candidate_summary, comp_notes, visa_status, target_roles, back_of_resume_notes, joe_says)",
          "resume.raw_text and resume.ai_summary",
          "notes",
          "call_notes (ai_summary, extracted_* fields, ai_action_items)",
          "job.description (the job spec) and job.compensation",
          "existing_submission",
        ],
        warning:
          "Use notes and call_notes to clarify products, systems, leadership scope, compensation, visa status, and target role fit. Do not invent experience, systems, employers, dates, degrees, certifications, or accomplishments.",
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Context fetch failed" });
  }
}
