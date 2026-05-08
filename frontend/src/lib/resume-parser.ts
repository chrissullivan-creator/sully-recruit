/**
 * Single source of truth for resume parsing.
 *
 * Strategy: extract raw text locally (pdf-parse / mammoth / TextDecoder)
 * and run it through the unified AI cascade (Gemini → Claude → OpenAI;
 * see lib/ai-fallback.ts). For parser callers we typically pass only
 * gemini + openai keys, which collapses the cascade to Gemini → OpenAI.
 * Affinda / Eden AI is retired.
 *
 * Used by:
 *   - frontend/api/parse-resume.ts                       (Vercel — interactive AddCandidate)
 *   - frontend/src/trigger/resume-ingestion.ts           (Trigger — bulk-drop / inbox)
 *   - frontend/src/trigger/reconcile-orphaned-resumes.ts (Trigger — reconcile)
 *   - frontend/src/trigger/reparse-resumes.ts            (Trigger — reparse)
 *
 * Both Vercel and Trigger.dev run Node 20+ with global fetch / Buffer.
 */

// No static imports. Earlier we imported callAIWithFallback here, but
// Vercel's serverless ESM bundler couldn't follow the resulting
// second-hop relative import (api/parse-resume → resume-parser →
// ai-fallback) and the function failed to load with
// ERR_MODULE_NOT_FOUND, surfacing as Vercel's "A server error has
// occurred" HTML. parseResume() now takes a callAI callback so the
// caller wires in the AI cascade and resume-parser.ts stays leaf.

export interface ParsedResume {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  location?: string;
  current_title?: string;
  current_company?: string;
  skills?: string[];
  [key: string]: any;
}

export interface ParseResumeResult {
  parsed: ParsedResume;
  /** Raw text extracted from the file before AI parsing. */
  rawText: string | null;
  /** Which provider in the cascade actually answered. */
  via: string;
}

/**
 * Caller-supplied AI invocation. Decoupled so parseResume() doesn't
 * have to import the cascade — see the file-level comment for why.
 */
export type CallAI = (req: {
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  jsonOutput: boolean;
}) => Promise<{ text: string; via: string }>;

export interface ParseResumeOptions {
  callAI: CallAI;
  /** Mistral OCR key — when set, OCR runs before pdf-parse fallback. */
  mistralKey?: string;
  log?: { warn: (msg: string, meta?: any) => void };
}

const SYSTEM_PROMPT =
  "You parse résumés into strict JSON matching the requested shape. Output null when a field is missing — never invent values.";

const USER_PROMPT_TEMPLATE = `Parse this resume into structured JSON. Return ONLY valid JSON, no markdown.

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
__TEXT__`;

/**
 * Parse a resume via the AI cascade. Extracts text locally, asks the
 * first available provider for structured JSON, and returns the parsed
 * fields plus the raw text we fed in. Throws if no provider keys are
 * supplied or the response can't be parsed as JSON.
 */
export async function parseResume(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
  opts: ParseResumeOptions,
): Promise<ParseResumeResult> {
  if (typeof opts.callAI !== "function") {
    throw new Error("parseResume: opts.callAI is required");
  }

  const rawText = await extractResumeText(fileBytes, fileName, { mistralKey: opts.mistralKey });
  if (!rawText || rawText.trim().length < 30) {
    // Empty / image-only PDF that pdf-parse couldn't decode — surface a
    // typed error so callers can mark the row failed instead of treating
    // an empty parse as success.
    throw new Error("parseResume: extracted text is empty or unreadable");
  }

  const userContent = USER_PROMPT_TEMPLATE.replace("__TEXT__", rawText.slice(0, 60_000));

  const { text, via } = await opts.callAI({
    systemPrompt: SYSTEM_PROMPT,
    userContent,
    maxTokens: 2048,
    jsonOutput: true,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`parseResume: no JSON in ${via} response`);
  let parsed: ParsedResume;
  try {
    parsed = JSON.parse(jsonMatch[0]) as ParsedResume;
  } catch (err: any) {
    throw new Error(`parseResume: JSON.parse failed on ${via} response — ${err.message}`);
  }

  // Normalize skills to a string[] regardless of provider quirks.
  const skills = Array.isArray(parsed.skills)
    ? parsed.skills
        .map((s: any) => (typeof s === "string" ? s : s?.name ?? s?.skill ?? ""))
        .filter((s: any) => typeof s === "string" && s.trim())
        .slice(0, 25)
    : [];
  parsed.skills = skills;

  return { parsed, rawText: rawText.slice(0, 16_000), via };
}

/**
 * Standalone text extraction. Kept for callers that want a `raw_text`
 * column without running the full parseResume (e.g. the resume-ingestion
 * sanity check).
 *
 * Order of attempts:
 *   1. Mistral OCR (when mistralKey provided) — handles scanned /
 *      image-only PDFs and gracefully falls through on any failure.
 *   2. pdf-parse / mammoth / TextDecoder by extension.
 *
 * Returns "" when nothing yields readable text — parseResume() rejects
 * empty extractions so the row is marked failed rather than silently
 * parsing as a blank candidate.
 */
export async function extractResumeText(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
  opts: { mistralKey?: string } = {},
): Promise<string> {
  const lower = (fileName || "").toLowerCase();
  const buffer = Buffer.from(fileBytes as any);

  // Mistral OCR for PDFs and images — primary path.
  if (opts.mistralKey && (lower.endsWith(".pdf") || /\.(png|jpe?g|tiff?|webp|gif|bmp)$/i.test(lower))) {
    const mistralText = await mistralOCR(buffer, lower, opts.mistralKey);
    if (mistralText && mistralText.trim().length >= 30) {
      return mistralText.slice(0, 16_000);
    }
  }

  if (lower.endsWith(".txt")) {
    return new TextDecoder().decode(buffer).slice(0, 16_000);
  }

  if (lower.endsWith(".docx")) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.default.extractRawText({ buffer });
      return (result.value || "").trim().slice(0, 16_000);
    } catch {
      return "";
    }
  }

  if (lower.endsWith(".doc")) {
    // Legacy binary Word format — mammoth doesn't read it; word-extractor
    // parses the OLE compound binary (pure JS, no native deps).
    try {
      const mod: any = await import("word-extractor");
      const Extractor = mod.default ?? mod;
      const extractor = new Extractor();
      const doc = await extractor.extract(buffer);
      return (doc.getBody() || "").trim().slice(0, 16_000);
    } catch {
      return "";
    }
  }

  if (lower.endsWith(".pdf")) {
    try {
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const result = await Promise.race([
        pdfParse(buffer),
        new Promise<{ text: string }>((_, rej) =>
          setTimeout(() => rej(new Error("pdf-parse timeout 20s")), 20_000),
        ),
      ]);
      return (result.text || "").trim().slice(0, 16_000);
    } catch {
      return "";
    }
  }

  return new TextDecoder().decode(buffer).slice(0, 16_000);
}

/**
 * Mistral OCR call — POST https://api.mistral.ai/v1/ocr.
 * Returns "" (not throws) on any failure so the caller falls through
 * to pdf-parse / mammoth.
 */
async function mistralOCR(
  buffer: Buffer,
  lowerFileName: string,
  apiKey: string,
): Promise<string> {
  const isPdf = lowerFileName.endsWith(".pdf");
  const isImage = /\.(png|jpe?g|tiff?|webp|gif|bmp)$/i.test(lowerFileName);
  if (!isPdf && !isImage) return "";

  const base64 = buffer.toString("base64");
  const mime = isPdf
    ? "application/pdf"
    : (lowerFileName.endsWith(".png") ? "image/png" : "image/jpeg");
  const dataUri = `data:${mime};base64,${base64}`;

  try {
    const resp = await fetch("https://api.mistral.ai/v1/ocr", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "mistral-ocr-latest",
        document: isPdf
          ? { type: "document_url", document_url: dataUri }
          : { type: "image_url", image_url: dataUri },
      }),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    const pages = Array.isArray((data as any)?.pages) ? (data as any).pages : [];
    return pages
      .map((p: any) => (typeof p?.markdown === "string" ? p.markdown : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  } catch {
    return "";
  }
}
