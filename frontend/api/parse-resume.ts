import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/parse-resume
 *
 * Downloads a resume from Supabase Storage, extracts text, and calls Claude
 * to parse structured candidate data. Returns parsed JSON — no DB writes.
 *
 * Body: { filePath: string, fileName: string }
 * Auth: Supabase JWT (from logged-in user)
 */

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!serviceKey || !supabaseUrl) {
    return res.status(500).json({ error: "Server misconfigured: missing Supabase credentials" });
  }

  if (!anthropicKey) {
    return res.status(500).json({ error: "Server misconfigured: missing ANTHROPIC_API_KEY" });
  }

  // Auth: validate Supabase JWT
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { filePath, fileName } = req.body;

    if (!filePath || !fileName) {
      return res.status(400).json({ error: "Missing required fields: filePath, fileName" });
    }

    // Use service role client to download from storage
    const admin = createClient(supabaseUrl, serviceKey);

    // 1. Download file from Supabase Storage
    const { data: downloadData, error: downloadErr } = await admin.storage
      .from("resumes")
      .download(filePath);

    if (downloadErr || !downloadData) {
      return res.status(500).json({ error: `Failed to download file: ${downloadErr?.message || "no data"}` });
    }

    const fileBytes = new Uint8Array(await downloadData.arrayBuffer());

    // 2. Extract text based on file type
    const rawText = extractText(fileBytes, fileName);

    // 3. Parse with Claude
    const parsed = await parseWithClaude(fileBytes, fileName, rawText, anthropicKey);

    return res.status(200).json({ parsed });
  } catch (err: any) {
    console.error("Parse resume error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function extractText(fileBytes: Uint8Array, fileName: string): string {
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
    return "[DOC - parsed via Claude]";
  }

  // PDF — Claude handles natively via document API
  if (lowerName.endsWith(".pdf")) {
    return "[PDF - parsed via Claude document API]";
  }

  return new TextDecoder().decode(fileBytes).slice(0, 8000);
}

function extractDocxText(zipData: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (let i = 0; i < zipData.length - 30; i++) {
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
  return "[DOCX - could not extract, parsed via Claude]";
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

  return {};
}
