import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getEdenAIKey } from "./lib/supabase";
import { buildProfileText, getVoyageEmbedding } from "./lib/resume-parsing";
import { generateJoeSays } from "./generate-joe-says";
import { classifyEmail, normalizeEmail } from "../lib/email-classifier";
import { parseResume, extractResumeText } from "../lib/resume-parser";

interface ResumeIngestionPayload {
  resumeId: string;
  candidateId: string;
  filePath: string;
  fileName: string;
}

export const resumeIngestion = task({
  id: "resume-ingestion",
  retry: { maxAttempts: 3 },
  run: async (payload: ResumeIngestionPayload) => {
    const { resumeId, candidateId, filePath, fileName } = payload;
    const supabase = getSupabaseAdmin();

    logger.info("Starting resume ingestion", { resumeId, candidateId, fileName });

    await supabase
      .from("resumes")
      .update({ parsing_status: "processing" })
      .eq("id", resumeId);

    // ── 1. Download file from Supabase Storage ──────────────────────
    const { data: downloadData, error: downloadErr } = await supabase.storage
      .from("resumes")
      .download(filePath);

    if (downloadErr || !downloadData) {
      throw new Error(`Failed to download file: ${downloadErr?.message || "no data"}`);
    }

    const fileBytes = new Uint8Array(await downloadData.arrayBuffer());
    logger.info("Downloaded file", { size: fileBytes.length });

    // ── 2. Pre-AI sanity check (does this look like a resume?) ──────
    // Cheap heuristic before we burn AI tokens on something that isn't a
    // resume. shared extractor handles PDF/DOCX/DOC/TXT; the parser will
    // re-extract internally too — that's fine, it's a tiny cost vs. the
    // value of skipping junk.
    const sniffText = await extractResumeText(fileBytes, fileName, { log: logger });
    if (!looksLikeResume(sniffText)) {
      logger.warn("File does not look like a resume; skipping AI parse", {
        fileName, textLength: sniffText.length,
      });
      await supabase
        .from("resumes")
        .update({
          raw_text: sniffText.slice(0, 4000),
          parsing_status: "rejected_not_a_resume",
        })
        .eq("id", resumeId);
      return { skipped: true, reason: "not_a_resume" };
    }

    // ── 3. Parse via Affinda (Eden AI) ──────────────────────────────
    const edenKey = await getEdenAIKey();
    if (!edenKey) throw new Error("EDEN_AI_API_KEY missing in app_settings");
    const { parsed: parsedJson, rawText, via } = await parseResume(fileBytes, fileName, {
      edenKey,
      log: logger,
    });
    const parser = `trigger-${via}`;
    logger.info("Parsed resume", { parsed: parsedJson, parser });

    // ── 4. Update resumes table ─────────────────────────────────────
    await supabase
      .from("resumes")
      .update({
        raw_text: rawText ?? sniffText,
        parsed_json: parsedJson,
        parsing_status: "completed",
        parser,
      })
      .eq("id", resumeId);

    // ── 5. Update candidate with parsed fields ──────────────────────
    // parsedJson.email = email found IN the resume = candidate's personal email.
    // Always tag as candidate and clear is_stub on successful resume parse.
    if (parsedJson && candidateId) {
      const updates: any = {
        roles: ["candidate"],
        is_stub: false,
      };
      if (parsedJson.first_name) updates.first_name = parsedJson.first_name;
      if (parsedJson.last_name) updates.last_name = parsedJson.last_name;
      if (parsedJson.first_name && parsedJson.last_name) {
        updates.full_name = `${parsedJson.first_name} ${parsedJson.last_name}`;
      }
      if (parsedJson.email) {
        // Word docx extraction leaks "HYPERLINK" garbage and sometimes a
        // comma-joined pair of addresses; normalize first, then classify.
        const cleaned = normalizeEmail(parsedJson.email);
        if (cleaned) {
          updates.email = cleaned;
          Object.assign(updates, classifyEmail(cleaned));
        }
      }
      if (parsedJson.phone) {
        updates.phone = parsedJson.phone;
        updates.mobile_phone = parsedJson.phone;
      }
      if (parsedJson.current_company) updates.current_company = parsedJson.current_company;
      if (parsedJson.current_title) updates.current_title = parsedJson.current_title;
      if (parsedJson.location) updates.location_text = parsedJson.location;
      if (parsedJson.linkedin_url) updates.linkedin_url = parsedJson.linkedin_url;
      if (parsedJson.skills?.length) updates.skills = parsedJson.skills;

      await supabase.from("people").update(updates).eq("id", candidateId);
    }

    // ── 6. Embed full profile with Voyage and store in resume_embeddings ──
    const textForEmbed = rawText ?? sniffText;
    if (candidateId && textForEmbed.length > 50) {
      try {
        const { data: candidate } = await supabase
          .from("people")
          .select("id, full_name, current_title, current_company, location_text, skills")
          .eq("id", candidateId)
          .single();

        if (candidate) {
          const profileText = buildProfileText(candidate, textForEmbed, parsedJson);
          const embedding = await getVoyageEmbedding(profileText);

          await supabase
            .from("resume_embeddings")
            .delete()
            .eq("candidate_id", candidateId)
            .eq("embed_type", "full_profile");

          await supabase.from("resume_embeddings").insert({
            candidate_id: candidateId,
            resume_id: resumeId,
            embedding: JSON.stringify(embedding),
            source_text: profileText.slice(0, 2000),
            chunk_text: profileText.slice(0, 2000),
            chunk_index: 0,
            embed_type: "full_profile",
            embed_model: "voyage-finance-2",
          });

          logger.info("Embedded resume with Voyage", { candidateId });
        }
      } catch (err: any) {
        logger.warn("Voyage embedding failed, will retry on next ingestion", { error: err.message });
      }
    }

    // Chain-trigger Joe Says refresh after resume parsing
    await generateJoeSays.trigger({
      entityId: candidateId,
      entityType: "candidate",
    });

    return { success: true, resumeId, candidateId };
  },
});

/**
 * Cheap pre-AI guard: does this look like a resume?
 *
 * Triggers a soft rejection if the extracted text is too short, missing
 * any email pattern, AND missing all resume-shaped keywords. The bar is
 * intentionally low — false positives waste a few cents of AI tokens,
 * false negatives lose a candidate. So we only reject when *all three*
 * signals are missing.
 */
function looksLikeResume(rawText: string): boolean {
  const text = (rawText || "").toLowerCase();
  if (text.length < 200) return false;

  const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);
  const KEYWORDS = [
    "experience", "education", "skills", "summary", "objective",
    "employment", "qualifications", "responsibilities", "achievements",
    "university", "college", "bachelor", "master", "ph.d", "phd",
    "linkedin.com/in",
  ];
  const hasKeyword = KEYWORDS.some((k) => text.includes(k));

  if (hasEmail && hasKeyword) return true;
  if (hasEmail || hasKeyword) return true;
  return false;
}
