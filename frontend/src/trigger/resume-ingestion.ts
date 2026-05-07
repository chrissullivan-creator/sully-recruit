import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getGeminiKey, getOpenAIKey } from "./lib/supabase";
import { buildProfileText, getVoyageEmbedding } from "./lib/resume-parsing";
import { generateJoeSays } from "./generate-joe-says";
import { classifyEmail, normalizeEmail } from "../lib/email-classifier";
import { matchPersonByEmail } from "./lib/match-person-by-email";
import { extractResumeText } from "../lib/resume-parser";
import { callAIWithFallback } from "../lib/ai-fallback";

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

    // ── 3. Parse via Gemini (with OpenAI fallback) ──────────────────
    // Affinda/Eden AI was retired. Gemini is the primary parser
    // (cost-efficient + fast for résumé-shaped JSON), with OpenAI
    // as the fallback when Gemini hits quota/auth/rate-limit errors.
    const rawText = sniffText;
    const [geminiKey, openaiKey] = await Promise.all([
      getGeminiKey(),
      getOpenAIKey().catch(() => ""),
    ]);
    if (!geminiKey && !openaiKey) {
      throw new Error("Resume parser: neither GEMINI_API_KEY nor OPENAI_API_KEY set in app_settings");
    }

    const userPrompt = `Parse this resume into structured JSON. Return ONLY valid JSON, no markdown.

Extract:
{
  "first_name": "First",
  "last_name": "Last",
  "email": "email@example.com or null",
  "phone": "phone number or null",
  "linkedin_url": "linkedin URL or null",
  "current_title": "most recent job title",
  "current_company": "most recent company",
  "location": "city, state or null",
  "skills": ["skill1", "skill2"]
}

Resume text:
${rawText.slice(0, 60000)}`;

    const { text, via } = await callAIWithFallback({
      geminiKey: geminiKey || undefined,
      openaiKey: openaiKey || undefined,
      systemPrompt: "You parse resumes into strict JSON matching the requested shape. Output null when a field is missing — never invent values.",
      userContent: userPrompt,
      maxTokens: 2048,
      jsonOutput: true,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Resume parse: no JSON in response");
    const parsedJson = JSON.parse(jsonMatch[0]);
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

    // ── 4b. Redirect-to-existing-candidate ─────────────────────────
    // Forwards (cloudflare-email + Outlook resumes inbox) hand us a
    // fresh stub since they don't know the candidate's real identity
    // — that lives in parsed_json. If the parsed email or linkedin_url
    // already belongs to someone in the DB, re-point this resume row
    // to them and delete the placeholder stub. Otherwise the stub
    // becomes the candidate (next block fills in the parsed fields).
    let workingCandidateId = candidateId;
    if (parsedJson) {
      const parsedEmail = normalizeEmail(parsedJson.email);
      const parsedLi = (parsedJson.linkedin_url || "").trim() || null;

      let match: { id: string } | null = null;
      if (parsedEmail) {
        const m = await matchPersonByEmail(supabase, parsedEmail);
        if (m && m.entityId !== candidateId) match = { id: m.entityId };
      }
      if (!match && parsedLi) {
        const slug = (parsedLi.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i)?.[1] ?? "").toLowerCase();
        if (slug) {
          const { data } = await supabase
            .from("people")
            .select("id")
            .ilike("linkedin_url", `%${slug}%`)
            .neq("id", candidateId)
            .limit(1)
            .maybeSingle();
          if (data?.id) match = data;
        }
      }

      if (match) {
        // Re-point the resumes row to the real candidate and drop
        // the placeholder stub so we don't leave dangling rows.
        await supabase
          .from("resumes")
          .update({ candidate_id: match.id })
          .eq("id", resumeId);

        // Only delete the stub if it has no other resumes attached
        // and is_stub=true (i.e. truly a forwarder placeholder).
        const { data: stub } = await supabase
          .from("people")
          .select("id, is_stub")
          .eq("id", candidateId)
          .maybeSingle();
        const { count: otherResumes } = await supabase
          .from("resumes")
          .select("id", { count: "exact", head: true })
          .eq("candidate_id", candidateId);
        if (stub?.is_stub && (otherResumes ?? 0) === 0) {
          await supabase.from("people").delete().eq("id", candidateId);
        }

        logger.info("Resume re-pointed to existing candidate", {
          stub: candidateId, real: match.id, parsedEmail, parsedLi,
        });
        workingCandidateId = match.id;
      }
    }

    // ── 5. Update candidate with parsed fields ──────────────────────
    // parsedJson.email = email found IN the resume = candidate's personal email.
    // Always tag as candidate and clear is_stub on successful resume parse.
    if (parsedJson && workingCandidateId) {
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
        // Plain `email` column was retired — only write personal/work.
        const cleaned = normalizeEmail(parsedJson.email);
        if (cleaned) Object.assign(updates, classifyEmail(cleaned));
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

      await supabase.from("people").update(updates).eq("id", workingCandidateId);
    }

    // ── 6. Embed full profile with Voyage and store in resume_embeddings ──
    const textForEmbed = rawText ?? sniffText;
    if (workingCandidateId && textForEmbed.length > 50) {
      try {
        const { data: candidate } = await supabase
          .from("people")
          .select("id, full_name, current_title, current_company, location_text, skills")
          .eq("id", workingCandidateId)
          .single();

        if (candidate) {
          const profileText = buildProfileText(candidate, textForEmbed, parsedJson);
          const embedding = await getVoyageEmbedding(profileText);

          await supabase
            .from("resume_embeddings")
            .delete()
            .eq("candidate_id", workingCandidateId)
            .eq("embed_type", "full_profile");

          await supabase.from("resume_embeddings").insert({
            candidate_id: workingCandidateId,
            resume_id: resumeId,
            embedding: JSON.stringify(embedding),
            source_text: profileText.slice(0, 2000),
            chunk_text: profileText.slice(0, 2000),
            chunk_index: 0,
            embed_type: "full_profile",
            embed_model: "voyage-finance-2",
          });

          logger.info("Embedded resume with Voyage", { candidateId: workingCandidateId });
        }
      } catch (err: any) {
        logger.warn("Voyage embedding failed, will retry on next ingestion", { error: err.message });
      }
    }

    // Chain-trigger Joe Says refresh after resume parsing
    await generateJoeSays.trigger({
      entityId: workingCandidateId,
      entityType: "candidate",
    });

    return { success: true, resumeId, candidateId: workingCandidateId };
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
