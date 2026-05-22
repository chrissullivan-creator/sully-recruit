import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/gpt/save-formatted-sendout
 *
 * Persists the output of the Ask Joe Send-Out GPT:
 *   1) Inserts a `formatted_resumes` row (text only — the PDF stays in
 *      ChatGPT for the user to download).
 *   2) Creates the candidate↔job `send_outs` row if one doesn't exist
 *      yet (this is the "tag the job" step), stamps the submission
 *      blurb on it, sets stage='submitted' + sent_to_client_at=now().
 *      If a row already exists, advances it from a pre-submission
 *      stage to 'submitted' (idempotent — won't downgrade later stages).
 *   3) Best-effort log row into stage_transitions, mirroring the
 *      in-app move-stage mutation.
 *
 * Body:
 *   candidate_id            UUID, required
 *   job_id                  UUID, required
 *   formatted_resume_text   string, required — markdown/plain text body
 *   blurb                   string, required — candidate-intro paragraph
 *   version_label           optional, e.g. "v1 — Goldman MD". Defaults to "GPT v1".
 *   recruiter_email         optional — if provided, the matching auth.users.id
 *                           is stamped on send_outs.recruiter_id and
 *                           formatted_resumes.created_by for attribution.
 *
 * Auth: SUPABASE_SERVICE_ROLE_KEY bearer or Supabase user JWT.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const {
      candidate_id,
      job_id,
      formatted_resume_text,
      blurb,
      version_label,
      recruiter_email,
    } = req.body ?? {};

    if (!candidate_id || typeof candidate_id !== "string") {
      return res.status(400).json({ error: "Missing required field: candidate_id" });
    }
    if (!job_id || typeof job_id !== "string") {
      return res.status(400).json({ error: "Missing required field: job_id" });
    }
    if (!formatted_resume_text || typeof formatted_resume_text !== "string") {
      return res.status(400).json({ error: "Missing required field: formatted_resume_text" });
    }
    if (!blurb || typeof blurb !== "string") {
      return res.status(400).json({ error: "Missing required field: blurb" });
    }

    // Resolve recruiter user id from email, if provided. Best-effort —
    // missing/unknown emails fall through to null attribution rather than failing.
    // profiles.id is the auth.users.id PK; email lives on the profile row.
    let attributedUserId: string | null = auth.userId;
    if (typeof recruiter_email === "string" && recruiter_email.trim()) {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .ilike("email", recruiter_email.trim())
          .maybeSingle();
        if (profile?.id) attributedUserId = profile.id;
      } catch {
        // Ignore — fall back to auth.userId (null for service-role callers).
      }
    }

    const nowIso = new Date().toISOString();

    // 1. Insert formatted_resumes row. `content_text` is added by
    //    migration 20260522020000_gpt_action_fields.sql; the generated
    //    Supabase types may lag the migration, hence the cast.
    const { data: frRow, error: frErr } = await supabase
      .from("formatted_resumes")
      .insert({
        candidate_id,
        job_id,
        content_text: formatted_resume_text,
        version_label: version_label || "GPT v1",
        created_by: attributedUserId,
        mime_type: "text/markdown",
      } as any)
      .select("id")
      .single();
    if (frErr) {
      return res.status(500).json({ error: `formatted_resumes insert: ${frErr.message}` });
    }

    // 2. Upsert send_outs — create if missing, advance to 'submitted' if pre-submission.
    const { data: existing, error: existingErr } = await supabase
      .from("send_outs")
      .select("id, stage")
      .eq("candidate_id", candidate_id)
      .eq("job_id", job_id)
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      return res.status(500).json({ error: `send_outs lookup: ${existingErr.message}` });
    }

    let sendOutId: string;
    let fromStage: string | null = null;
    const preSubmissionStages = new Set([
      "lead", "new", "back_of_resume", "reached_out", "pitch", "send_out",
    ]);

    if (existing) {
      sendOutId = existing.id;
      fromStage = existing.stage;
      const patch: Record<string, any> = {
        submission_blurb: blurb,
        updated_at: nowIso,
      };
      // Only advance to 'submitted' if currently pre-submission. Don't
      // downgrade from interview/offer/placed.
      if (preSubmissionStages.has(existing.stage)) {
        patch.stage = "submitted";
        patch.sent_to_client_at = nowIso;
      }
      const { error: updErr } = await supabase
        .from("send_outs")
        .update(patch as any)
        .eq("id", sendOutId);
      if (updErr) {
        return res.status(500).json({ error: `send_outs update: ${updErr.message}` });
      }
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from("send_outs")
        .insert({
          candidate_id,
          job_id,
          stage: "submitted",
          sent_to_client_at: nowIso,
          submission_blurb: blurb,
          recruiter_id: attributedUserId,
        } as any)
        .select("id")
        .single();
      if (insErr) {
        return res.status(500).json({ error: `send_outs insert: ${insErr.message}` });
      }
      sendOutId = inserted.id;
    }

    // 3. Best-effort stage_transitions log. Mirrors move-stage.ts.
    try {
      await supabase.from("stage_transitions").insert({
        entity_type: "send_out",
        entity_id: sendOutId,
        from_stage: fromStage,
        to_stage: "submitted",
        moved_by: attributedUserId,
        trigger_source: "gpt_send_out",
        triggered_by_user_id: attributedUserId,
      });
    } catch {
      // Logging failure is non-critical.
    }

    return res.status(200).json({
      ok: true,
      send_out_id: sendOutId,
      formatted_resume_id: frRow.id,
      stage: "submitted",
      previous_stage: fromStage,
    });
  } catch (err: any) {
    console.error("gpt/save-formatted-sendout error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
