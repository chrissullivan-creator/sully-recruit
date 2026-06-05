import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAnthropicKey,
  getGeminiKey,
  getOpenAIKey,
  getOpenRouterKey,
  getMistralKey,
} from "../../../../src/server-lib/supabase.js";
import {
  buildProfileText,
  getVoyageEmbedding,
} from "../../../../src/server-lib/resume-parsing.js";
import { classifyEmail, normalizeEmail } from "../../../../src/lib/email-classifier.js";
import { matchPersonByEmail } from "../../../../src/server-lib/match-person-by-email.js";
import { extractResumeText } from "../../../../src/lib/resume-parser.js";
import { callAIWithFallback, RESUME_PARSE_ORDER } from "../../../../src/lib/ai-fallback.js";

interface ResumeIngestionPayload {
  resumeId: string;
  candidateId: string;
  filePath: string;
  fileName: string;
}

/**
 * Parse a single resume: download from Supabase Storage → Mistral OCR
 * (with pdf-parse fallback) → OpenAI-first AI cascade (OpenAI → Claude →
 * Gemini → OpenRouter) → stamp the candidate row → embed with Voyage →
 * fire `ai/joe-says.requested`.
 *
 * Re-points to an existing candidate when the parsed email or LinkedIn
 * URL already belongs to someone else (forwards from cloudflare-email +
 * the resumes inbox always create a fresh stub since they don't know
 * the candidate's real identity yet).
 *
 * Concurrency keyed on `resumeId` so a duplicate event for the same
 * resume can't double-parse.
 *
 * Ported from `src/trigger/resume-ingestion.ts`. The Trigger.dev
 * `resumeIngestion` task remains as a thin pass-through that sends
 * `ai/resume-ingestion.requested`, so any caller still using
 * `resumeIngestion.trigger(...)` keeps working until they migrate.
 */
export const resumeIngestion = inngest.createFunction(
  {
    id: "resume-ingestion",
    name: "Parse + embed a resume (Inngest)",
    retries: 3,
    concurrency: [{ key: "event.data.resumeId", limit: 1 }],
  },
  { event: "ai/resume-ingestion.requested" },
  async ({ event, logger }) => {
    const { resumeId, candidateId, filePath, fileName } = event.data as ResumeIngestionPayload;
    const supabase = getSupabaseAdmin();

    logger.info("Starting resume ingestion", { resumeId, candidateId, fileName });

    await supabase
      .from("resumes")
      .update({ parsing_status: "processing" })
      .eq("id", resumeId);

    try {
      return await runIngestion();
    } catch (err: any) {
      logger.error("Resume ingestion failed", { resumeId, candidateId, error: err?.message });
      await supabase
        .from("resumes")
        .update({ parsing_status: "failed" })
        .eq("id", resumeId);
      throw err;
    }

    async function runIngestion() {
      const { data: downloadData, error: downloadErr } = await supabase.storage
        .from("resumes")
        .download(filePath);

      if (downloadErr || !downloadData) {
        throw new Error(`Failed to download file: ${downloadErr?.message || "no data"}`);
      }

      const fileBytes = new Uint8Array(await downloadData.arrayBuffer());
      logger.info("Downloaded file", { size: fileBytes.length });

      const mistralKey = await getMistralKey().catch(() => "");
      const sniffText = await extractResumeText(fileBytes, fileName, { mistralKey });
      if (!looksLikeResume(sniffText)) {
        logger.warn("File does not look like a resume; skipping AI parse", {
          fileName,
          textLength: sniffText.length,
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

      const rawText = sniffText;
      const [anthropicKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
        getAnthropicKey().catch(() => ""),
        getOpenAIKey().catch(() => ""),
        getGeminiKey().catch(() => ""),
        getOpenRouterKey().catch(() => ""),
      ]);
      if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
        throw new Error("Resume parser: no ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY in app_settings");
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
        anthropicKey: anthropicKey || undefined,
        openaiKey: openaiKey || undefined,
        geminiKey: geminiKey || undefined,
        openRouterKey: openRouterKey || undefined,
        order: RESUME_PARSE_ORDER,
        systemPrompt: "You parse resumes into strict JSON matching the requested shape. Output null when a field is missing — never invent values.",
        userContent: userPrompt,
        maxTokens: 2048,
        jsonOutput: true,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Resume parse: no JSON in response");
      const parsedJson = JSON.parse(jsonMatch[0]);
      const parser = `inngest-${via}`;
      logger.info("Parsed resume", { parsed: parsedJson, parser });

      await supabase
        .from("resumes")
        .update({
          raw_text: rawText ?? sniffText,
          parsed_json: parsedJson,
          parsing_status: "completed",
          parser,
        })
        .eq("id", resumeId);

      // Redirect-to-existing-candidate: forwarders create stubs blind.
      // If the parsed email/linkedin matches an existing person, repoint
      // the resume row and drop the empty stub.
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
          await supabase
            .from("resumes")
            .update({ candidate_id: match.id })
            .eq("id", resumeId);

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
            stub: candidateId,
            real: match.id,
            parsedEmail,
            parsedLi,
          });
          workingCandidateId = match.id;
        }
      }

      // Update candidate with parsed fields. Always tag as candidate and
      // clear is_stub on successful resume parse.
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
        if (filePath) {
          updates.resume_url = `https://xlobevmhzimxjtpiontf.supabase.co/storage/v1/object/public/resumes/${filePath}`;
        }

        const { error: peopleUpdateErr } = await supabase
          .from("people")
          .update(updates)
          .eq("id", workingCandidateId);
        if (peopleUpdateErr) {
          logger.error("Failed to update candidate after resume parse", {
            candidateId: workingCandidateId,
            error: peopleUpdateErr.message,
          });
          throw new Error(`Candidate update failed: ${peopleUpdateErr.message}`);
        }
      }

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

      // Fire Joe Says refresh. Best-effort — ingestion has already
      // committed the parsed data, so a Joe Says failure shouldn't fail
      // the run or burn retries.
      try {
        await inngest.send({
          name: "ai/joe-says.requested",
          data: { entityId: workingCandidateId, entityType: "candidate" },
        });
      } catch (err: any) {
        logger.warn("ai/joe-says.requested send failed after resume ingestion", {
          candidateId: workingCandidateId,
          error: err?.message,
        });
      }

      // When the resume didn't yield a LinkedIn URL, queue a search by
      // name + current_company. If find-linkedin-url-by-name lands a
      // confident match it writes the URL back, which trips the BEFORE
      // trigger that flips unipile_resolve_status='pending' and the
      // AFTER trigger that fires the entity-history fetch. No-op if the
      // parser already wrote a URL (function exits early on its own).
      if (!parsedJson?.linkedin_url) {
        try {
          await inngest.send({
            name: "people/find-linkedin-url.requested",
            data: { person_id: workingCandidateId },
          });
        } catch (err: any) {
          logger.warn("people/find-linkedin-url.requested send failed", {
            candidateId: workingCandidateId,
            error: err?.message,
          });
        }
      }

      return { success: true, resumeId, candidateId: workingCandidateId };
    }
  },
);

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
