import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { classifyEmail, normalizeEmail } from "../src/lib/email-classifier.js";

/**
 * POST /api/save-to-pipeline
 *
 * Single-button orchestration triggered from the Source page (Applicants /
 * Search tabs). Atomically:
 *   1) Resolves the internal job linked to this LinkedIn project
 *      (jobs.linkedin_project_id + jobs.linkedin_project_account_id).
 *      If the caller passes job_id, that pair is persisted on the job
 *      so subsequent Saves auto-tag without prompting.
 *   2) Asks Unipile for the project's first pipeline stage (entry point)
 *      and POSTs save_candidate to put the person in the LinkedIn pipeline.
 *   3) Dedupes in Supabase by linkedin_url, then by email columns. If a
 *      row exists, UPDATEs profile/headline/title/company/location and
 *      avatar from the Unipile payload while preserving any email/phone
 *      already present locally. Otherwise INSERTs a fresh candidate.
 *   4) If has_resume is set, downloads the resume from Unipile, uploads
 *      to the `resumes` bucket, creates a resumes row, and fires the
 *      ingestion task.
 *
 * Body:
 *   account_id     Unipile acc_xxx (required)
 *   project_id     Unipile hiring project id (required)
 *   applicant_id   LinkedIn candidate/profile id used by Unipile (required)
 *   applicant      Flat profile we already have in the UI; see fields below
 *   job_id         Optional internal job UUID. When provided, the project↔job
 *                  link is persisted and used; otherwise the existing link
 *                  is required and a 409 is returned if missing.
 *   has_resume     If true, attempt resume download/parse.
 *
 * Auth: Supabase JWT.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const {
    account_id,
    project_id,
    applicant_id,
    applicant = {},
    job_id: providedJobId,
    has_resume = false,
  } = req.body || {};

  if (!account_id) return res.status(400).json({ error: "Missing account_id" });
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });
  if (!applicant_id) return res.status(400).json({ error: "Missing applicant_id" });

  try {
    // ── 1. Resolve internal job ─────────────────────────────────
    let jobId: string | null = providedJobId || null;
    if (jobId) {
      const { error: linkErr } = await supabase
        .from("jobs")
        .update({
          linkedin_project_id: project_id,
          linkedin_project_account_id: account_id,
        })
        .eq("id", jobId);
      if (linkErr) {
        // Unique index would block re-linking the same project to two
        // jobs; surface a clear message in that case.
        return res.status(409).json({
          error: `Could not link project to job: ${linkErr.message}`,
        });
      }
    } else {
      const { data: existing } = await supabase
        .from("jobs")
        .select("id")
        .eq("linkedin_project_id", project_id)
        .eq("linkedin_project_account_id", account_id)
        .maybeSingle();
      if (!existing?.id) {
        return res.status(409).json({
          error: "No internal job linked to this LinkedIn project. Pass job_id once to establish the link.",
          code: "PROJECT_NOT_LINKED",
        });
      }
      jobId = existing.id;
    }

    // ── 2. Unipile config + helpers ─────────────────────────────
    const [{ data: v2Row }, { data: v2KeyRow }, { data: v1KeyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
    ]);
    const v2Base = (v2Row?.value || "").replace(/\/+$/, "") || "https://api.unipile.com/v2";
    const apiKey = v2KeyRow?.value || v1KeyRow?.value;
    if (!apiKey) return res.status(500).json({ error: "Unipile API key not configured" });
    const acct = encodeURIComponent(account_id);
    const proj = encodeURIComponent(project_id);
    const unipileHeaders: Record<string, string> = {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    };

    // ── 3. Find the entry pipeline stage ────────────────────────
    // Project detail lists pipeline.stages in display order; the first
    // stage that accepts candidates is the entry point ("Sourced" /
    // "Uncontacted" depending on the recruiter's template).
    const projResp = await fetch(`${v2Base}/${acct}/linkedin/recruiter/projects/${proj}`, {
      headers: unipileHeaders,
    });
    if (!projResp.ok) {
      return res.status(projResp.status).json({
        error: `Unipile ${projResp.status}: project fetch failed`,
        detail: (await projResp.text()).slice(0, 500),
      });
    }
    const projectData: any = await projResp.json();
    const stages: any[] = projectData?.pipeline?.stages || [];
    const entryStage = stages.find((s) => s?.accepts_candidates) || stages[0];
    if (!entryStage?.id) {
      return res.status(422).json({
        error: "Project has no pipeline stages — cannot save candidate.",
      });
    }

    // ── 4. Unipile save_candidate ───────────────────────────────
    const saveResp = await fetch(
      `${v2Base}/${acct}/linkedin/recruiter/projects/${proj}/pipeline/candidate/save`,
      {
        method: "POST",
        headers: { ...unipileHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          stage_id: entryStage.id,
          candidate_id: applicant_id,
        }),
      },
    );
    if (!saveResp.ok && saveResp.status !== 409) {
      // 409 from Unipile = already in pipeline; that's a no-op, not a failure.
      const text = (await saveResp.text()).slice(0, 500);
      return res.status(saveResp.status).json({
        error: `Unipile ${saveResp.status}: save_candidate failed`,
        detail: text,
      });
    }

    // ── 5. Build candidate payload from the UI profile ──────────
    const work = (applicant.work_experience && applicant.work_experience[0]) || {};
    const firstName = applicant.first_name
      || (applicant.display_name?.split(/\s+/)[0])
      || "";
    const lastName = applicant.last_name
      || (applicant.display_name?.split(/\s+/).slice(1).join(" "))
      || "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
    const headline: string | null = applicant.headline || null;
    const currentTitle: string | null = applicant.current_title || work?.job_title || headline || null;
    const currentCompany: string | null =
      applicant.current_company || work?.company?.name || work?.company || null;
    const locationText: string | null = applicant.location || null;
    const linkedinUrl: string | null = applicant.linkedin_url || applicant.profile_url || null;
    const avatarUrl: string | null =
      applicant.profile_picture_url || applicant.public_picture_url || null;
    const incomingEmail = normalizeEmail(
      (Array.isArray(applicant.emails) ? applicant.emails[0] : applicant.email) || null,
    );
    const incomingPhone =
      (Array.isArray(applicant.phone_numbers) ? applicant.phone_numbers[0] : applicant.phone) || null;

    // ── 6. Dedupe by linkedin_url, then by any email column ─────
    let candidateId: string | null = null;
    let merged = false;
    let existing: any = null;

    if (linkedinUrl) {
      const { data } = await supabase
        .from("people")
        .select("id, personal_email, work_email, primary_email, phone, mobile_phone")
        .eq("linkedin_url", linkedinUrl)
        .maybeSingle();
      if (data?.id) existing = data;
    }
    if (!existing && incomingEmail) {
      const { data } = await supabase
        .from("people")
        .select("id, personal_email, work_email, primary_email, phone, mobile_phone")
        .or(
          `personal_email.ilike.${incomingEmail},work_email.ilike.${incomingEmail},primary_email.ilike.${incomingEmail}`,
        )
        .limit(1)
        .maybeSingle();
      if (data?.id) existing = data;
    }

    if (existing?.id) {
      candidateId = existing.id;
      merged = true;

      // Overwrite profile-ish fields with the fresh Unipile data; only
      // fill emails/phones if they're currently null locally.
      const updates: Record<string, any> = {
        first_name: firstName || undefined,
        last_name: lastName || undefined,
        full_name: fullName || undefined,
        linkedin_headline: headline,
        linkedin_current_title: currentTitle,
        linkedin_current_company: currentCompany,
        linkedin_location: locationText,
        linkedin_last_synced_at: new Date().toISOString(),
        current_title: currentTitle || undefined,
        current_company: currentCompany || undefined,
        location_text: locationText || undefined,
        linkedin_url: linkedinUrl || undefined,
        avatar_url: avatarUrl || undefined,
        updated_at: new Date().toISOString(),
      };
      // Strip undefineds so we don't blank columns the caller didn't send.
      Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);

      if (incomingEmail && !existing.personal_email && !existing.work_email && !existing.primary_email) {
        Object.assign(updates, classifyEmail(incomingEmail));
      }
      if (incomingPhone && !existing.phone && !existing.mobile_phone) {
        updates.phone = incomingPhone;
        updates.mobile_phone = incomingPhone;
      }

      const { error: upErr } = await supabase
        .from("people")
        .update(updates as any)
        .eq("id", existing.id);
      if (upErr) throw upErr;
    } else {
      const payload: Record<string, any> = {
        first_name: firstName || null,
        last_name: lastName || null,
        full_name: fullName,
        linkedin_url: linkedinUrl,
        linkedin_headline: headline,
        linkedin_current_title: currentTitle,
        linkedin_current_company: currentCompany,
        linkedin_location: locationText,
        linkedin_last_synced_at: new Date().toISOString(),
        current_title: currentTitle,
        current_company: currentCompany,
        location_text: locationText,
        avatar_url: avatarUrl,
        type: "candidate",
        roles: ["candidate"],
        status: "new",
        is_stub: false,
        source: "linkedin_hiring_project",
        source_detail: project_id,
        owner_user_id: user.id,
        created_by_user_id: user.id,
        unipile_resolve_status: linkedinUrl ? "pending" : null,
      };
      if (incomingEmail) Object.assign(payload, classifyEmail(incomingEmail));
      if (incomingPhone) {
        payload.phone = incomingPhone;
        payload.mobile_phone = incomingPhone;
      }

      const { data: row, error } = await supabase
        .from("people")
        .insert(payload as any)
        .select("id")
        .single();
      if (error) throw error;
      candidateId = row.id;
    }

    // ── 7. Resume download + ingestion ──────────────────────────
    let resumeQueued = false;
    if (has_resume && candidateId) {
      try {
        // Resumes live behind the project's talent-pool route; only
        // available for applicants (not arbitrary search results).
        const resumeUrl =
          `${v2Base}/${acct}/linkedin/recruiter/projects/${proj}` +
          `/talent-pool/applicants/${encodeURIComponent(applicant_id)}/resume`;
        const rResp = await fetch(resumeUrl, { headers: unipileHeaders });
        if (rResp.ok) {
          const contentType = rResp.headers.get("content-type") || "application/pdf";
          const buffer = Buffer.from(await rResp.arrayBuffer());
          if (buffer.length > 0) {
            const ext = contentType.includes("pdf") ? "pdf"
              : contentType.includes("docx") ? "docx" : "pdf";
            const safeName = `${firstName}_${lastName}_resume.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
            const storagePath = `${user.id}/${Date.now()}_${safeName}`;

            const { data: uploaded, error: uploadErr } = await supabase.storage
              .from("resumes")
              .upload(storagePath, buffer, { contentType, upsert: false });

            if (!uploadErr && uploaded?.path) {
              const { data: resumeRow, error: resumeErr } = await supabase
                .from("resumes")
                .insert({
                  candidate_id: candidateId,
                  file_path: uploaded.path,
                  file_name: safeName,
                  mime_type: contentType,
                  file_size: buffer.length,
                  parse_status: "pending",
                } as any)
                .select("id")
                .single();

              if (!resumeErr && resumeRow?.id) {
                // Fire-and-forget Inngest task. We don't await the response
                // so the Save click feels instant.
                fetch(`${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/trigger-resume-ingestion`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    resumeId: resumeRow.id,
                    candidateId,
                    filePath: uploaded.path,
                    fileName: safeName,
                  }),
                }).catch(() => {});
                resumeQueued = true;
              }
            }
          }
        }
      } catch (resumeErr: any) {
        // Resume is best-effort — don't fail the whole Save on a 404 etc.
        console.warn("Resume ingestion skipped:", resumeErr?.message);
      }
    }

    return res.status(200).json({
      candidate_id: candidateId,
      job_id: jobId,
      merged,
      stage_id: entryStage.id,
      stage_name: entryStage.name,
      resume_queued: resumeQueued,
    });
  } catch (err: any) {
    console.error("save-to-pipeline error:", err);
    return res.status(500).json({ error: err.message || "Save failed" });
  }
}
