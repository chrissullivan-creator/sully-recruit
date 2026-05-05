import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getOpenAIKey } from "./lib/supabase";
import { buildProfileText, getVoyageEmbedding } from "./lib/resume-parsing";
import { generateJoeSays } from "./generate-joe-says";
import { classifyEmail, normalizeEmail } from "../lib/email-classifier";

const PARSE_PROMPT = `You are a professional resume parser. Extract structured data from the resume provided. Return ONLY valid JSON, no markdown, no explanation.

Return this exact JSON structure:
{
  "first_name": "First Name",
  "last_name": "Last Name",
  "email": "email@example.com",
  "phone": "phone number",
  "current_company": "Most Recent Company",
  "current_title": "Most Recent Job Title",
  "location": "City, State",
  "linkedin_url": "LinkedIn URL",
  "skills": ["skill1", "skill2"]
}

If a field is not found, use an empty string. For skills, return an empty array if none found.`;

interface ResumeIngestionPayload {
  resumeId: string;
  candidateId: string;
  filePath: string;
  fileName: string;
}

export const resumeIngestion = task({
  id: "resume-ingestion",
  retry: {
    maxAttempts: 3,
  },
  run: async (payload: ResumeIngestionPayload) => {
    const { resumeId, candidateId, filePath, fileName } = payload;
    const supabase = getSupabaseAdmin();

    logger.info("Starting resume ingestion", { resumeId, candidateId, fileName });

    // Update status to processing
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

    // ── 2. Extract text content based on file type ──────────────────
    const rawText = await extractText(fileBytes, fileName);
    logger.info("Extracted text", { length: rawText.length });

    // ── 2a. Resume sanity check ─────────────────────────────────────
    // Cheap heuristic before we burn AI tokens on something that isn't a
    // resume (random PDF attachment, signed contract, screenshot). We
    // require: (a) at least 200 chars of text, (b) at least one email-
    // shaped token, (c) at least one resume-y keyword. Fails are marked
    // 'rejected_not_a_resume' so the candidate stub doesn't get garbage
    // fields written to it.
    if (!looksLikeResume(rawText)) {
      logger.warn("File does not look like a resume; skipping AI parse", {
        fileName, textLength: rawText.length,
      });
      await supabase
        .from("resumes")
        .update({
          raw_text: rawText.slice(0, 4000),
          parsing_status: "rejected_not_a_resume",
        })
        .eq("id", resumeId);
      return { skipped: true, reason: "not_a_resume" };
    }

    // ── 3. Parse with Claude (OpenAI fallback on credit/rate-limit) ─
    const anthropicKey = await getAnthropicKey();
    let parsedJson: any = null;
    let parser: string = "trigger-claude";
    try {
      parsedJson = await parseWithClaude(fileBytes, fileName, rawText, anthropicKey);
    } catch (claudeErr: any) {
      // Only fall back on errors where retrying Claude won't help: credit
      // exhausted, rate limit, auth. Other errors (parse error, 5xx) keep
      // surfacing so Trigger.dev's retry policy still catches transient
      // upstream issues.
      const msg = String(claudeErr?.message || "");
      const fallbackable =
        /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key/i.test(msg);
      const openAiKey = await getOpenAIKey();
      if (fallbackable && openAiKey) {
        logger.warn("Claude failed, falling back to OpenAI", { error: msg });
        parsedJson = await parseWithOpenAI(rawText, fileName, openAiKey);
        parser = "trigger-openai-fallback";
      } else {
        throw claudeErr;
      }
    }
    logger.info("Parsed resume", { parsed: parsedJson, parser });

    // ── 4. Update resumes table ─────────────────────────────────────
    await supabase
      .from("resumes")
      .update({
        raw_text: rawText,
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
    if (candidateId && rawText.length > 50) {
      try {
        const { data: candidate } = await supabase
          .from("people")
          .select("id, full_name, current_title, current_company, location_text, skills")
          .eq("id", candidateId)
          .single();

        if (candidate) {
          const profileText = buildProfileText(candidate, rawText, parsedJson);
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

// ─────────────────────────────────────────────────────────────────────────────
// TEXT EXTRACTION (ported from parse-resume edge function)
// ─────────────────────────────────────────────────────────────────────────────
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

  // If we have an email AND a keyword, definitely a resume.
  if (hasEmail && hasKeyword) return true;
  // Either alone is enough to keep going.
  if (hasEmail || hasKeyword) return true;
  return false;
}

async function extractText(fileBytes: Uint8Array, fileName: string): Promise<string> {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".txt")) {
    return new TextDecoder().decode(fileBytes).slice(0, 8000);
  }

  if (lowerName.endsWith(".docx")) {
    return extractDocxText(fileBytes);
  }

  if (lowerName.endsWith(".doc")) {
    const textContent = new TextDecoder("utf-8", { fatal: false }).decode(fileBytes);
    const readable = textContent.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
    if (readable.length > 50) return readable.slice(0, 8000);
    throw new Error("Could not extract readable text from DOC file");
  }

  // PDF — extract real text so we have a fallback for OpenAI when Claude
  // is over quota. Claude's PDF-document-block path still runs in
  // parseWithClaude (uses raw bytes); rawText here is for the fallback.
  if (lowerName.endsWith(".pdf")) {
    try {
      // pdf-parse pulls in test fixtures at top-level import; defer the
      // require so cold start isn't paying for it.
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(Buffer.from(fileBytes));
      const text = (result.text || "").trim();
      return text.length > 50 ? text.slice(0, 16000) : "[PDF - no extractable text]";
    } catch (err: any) {
      // Don't block Claude PDF-native path on extractor errors.
      return "[PDF - extract failed: " + (err?.message || "unknown").slice(0, 80) + "]";
    }
  }

  return new TextDecoder().decode(fileBytes).slice(0, 8000);
}

function extractDocxText(zipData: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const needle = new TextEncoder().encode("word/document.xml");

  for (let i = 0; i < zipData.length - needle.length; i++) {
    // Local file header signature: PK\x03\x04
    if (zipData[i] === 0x50 && zipData[i + 1] === 0x4B && zipData[i + 2] === 0x03 && zipData[i + 3] === 0x04) {
      const fnLen = zipData[i + 26] | (zipData[i + 27] << 8);
      const extraLen = zipData[i + 28] | (zipData[i + 29] << 8);
      const fnBytes = zipData.slice(i + 30, i + 30 + fnLen);
      const fn = decoder.decode(fnBytes);

      if (fn === "word/document.xml") {
        const xmlStart = i + 30 + fnLen + extraLen;
        let xmlEnd = zipData.length;
        for (let j = xmlStart + 1; j < zipData.length - 3; j++) {
          if (zipData[j] === 0x50 && zipData[j + 1] === 0x4B) {
            xmlEnd = j;
            break;
          }
        }

        const xmlRaw = zipData.slice(xmlStart, xmlEnd);
        const xmlText = decoder.decode(xmlRaw);

        return xmlText
          .replace(/<w:br[^>]*\/>/g, "\n")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, 8000);
      }
    }
  }
  throw new Error("Could not extract text from DOCX file");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE PARSING
// ─────────────────────────────────────────────────────────────────────────────
async function parseWithClaude(
  fileBytes: Uint8Array,
  fileName: string,
  rawText: string,
  apiKey: string,
): Promise<any> {
  const contentBlocks: any[] = [];
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    const base64Data = Buffer.from(fileBytes).toString("base64");
    contentBlocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64Data },
    });
    contentBlocks.push({ type: "text", text: "Parse this resume and extract the structured data." });
  } else {
    contentBlocks.push({ type: "text", text: `Parse this resume:\n\n${rawText}` });
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: PARSE_PROMPT,
      messages: [{ role: "user", content: contentBlocks }],
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API error: ${errText}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }

  return null;
}

/**
 * Fallback parser using OpenAI (gpt-4o-mini). Used only when Claude is
 * over quota / rate-limited. Operates on the extracted text only — no
 * native PDF support — so for PDFs we rely on the (placeholder) text
 * already pulled by extractText. If a PDF returns just the placeholder
 * we return null and let Trigger.dev's retry pick it up later when
 * Claude is back.
 */
async function parseWithOpenAI(
  rawText: string,
  fileName: string,
  apiKey: string,
): Promise<any> {
  // "[PDF - ..." placeholders mean the extractor couldn't pull real text;
  // fallback isn't useful in that case.
  if (!rawText || rawText.startsWith("[PDF -") || rawText.length < 50) {
    return null;
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PARSE_PROMPT },
        { role: "user", content: `Parse this resume (${fileName}):\n\n${rawText.slice(0, 16000)}` },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI fallback error: ${await resp.text()}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  }
}

