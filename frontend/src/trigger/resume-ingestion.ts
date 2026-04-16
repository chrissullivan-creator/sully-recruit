import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getVoyageKey } from "./lib/supabase";
import { buildProfileText } from "./lib/resume-parsing";
import { generateJoeSays } from "./generate-joe-says";

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

    // ── 3. Parse with Claude ────────────────────────────────────────
    const anthropicKey = await getAnthropicKey();
    const parsedJson = await parseWithClaude(fileBytes, fileName, rawText, anthropicKey);
    logger.info("Parsed resume", { parsed: parsedJson });

    // ── 4. Update resumes table ─────────────────────────────────────
    await supabase
      .from("resumes")
      .update({
        raw_text: rawText,
        parsed_json: parsedJson,
        parsing_status: "completed",
        parser: "trigger-claude",
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
        // Email in resume = candidate's personal email
        updates.email = parsedJson.email;
        updates.personal_email = parsedJson.email;
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

      await supabase.from("candidates").update(updates).eq("id", candidateId);
    }

    // ── 6. Embed full_profile with Voyage AI ──────────────────────────
    if (candidateId) {
      const { data: candidate } = await supabase
        .from("candidates")
        .select("id, full_name, current_title, current_company, location_text, skills")
        .eq("id", candidateId)
        .single();

      if (candidate) {
        const profileText = buildProfileText(candidate, rawText, parsedJson);
        if (profileText.trim().length >= 50) {
          const voyageKey = await getVoyageKey();
          const embedding = await embedWithVoyage(profileText, voyageKey);
          if (embedding) {
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
            logger.info("Stored full_profile embedding", { candidateId });
          }
        }
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

  // PDF — Claude handles natively via document API, so return empty for text
  // The actual parsing will use the PDF document block
  if (lowerName.endsWith(".pdf")) {
    return "[PDF - parsed via Claude document API]";
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

// ─────────────────────────────────────────────────────────────────────────────
// VOYAGE AI EMBEDDING
// ─────────────────────────────────────────────────────────────────────────────
async function embedWithVoyage(text: string, apiKey: string): Promise<number[] | null> {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "voyage-finance-2",
      input: text,
      input_type: "document",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    logger.error("Voyage API error", { error: errText });
    return null;
  }

  const data = await resp.json();
  return data.data?.[0]?.embedding ?? null;
}

