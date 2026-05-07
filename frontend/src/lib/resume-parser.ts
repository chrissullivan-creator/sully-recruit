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

// frontend/package.json declares `"type": "module"`, so when Vercel
// bundles serverless functions the resolver runs in Node ESM mode —
// which requires the explicit `.js` extension on relative imports.
// Without it the function fails to load with ERR_MODULE_NOT_FOUND
// (surfacing as Vercel's "A server error has occurred" page).
import { callAIWithFallback } from "./ai-fallback.js";

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
  via: "gemini" | "claude" | "openai";
}

export interface ParseResumeOptions {
  /** Gemini key — first in the cascade. */
  geminiKey?: string;
  /** OpenAI key — fallback. */
  openaiKey?: string;
  /** Anthropic key — optional middle stage if you want Claude as a fallback. */
  anthropicKey?: string;
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
  if (!opts.geminiKey && !opts.openaiKey && !opts.anthropicKey) {
    throw new Error("parseResume: at least one AI key (gemini/openai/anthropic) is required");
  }

  const rawText = await extractResumeText(fileBytes, fileName);
  if (!rawText || rawText.trim().length < 30) {
    // Empty / image-only PDF that pdf-parse couldn't decode — surface a
    // typed error so callers can mark the row failed instead of treating
    // an empty parse as success.
    throw new Error("parseResume: extracted text is empty or unreadable");
  }

  const userContent = USER_PROMPT_TEMPLATE.replace("__TEXT__", rawText.slice(0, 60_000));

  const { text, via } = await callAIWithFallback({
    geminiKey: opts.geminiKey || undefined,
    anthropicKey: opts.anthropicKey || undefined,
    openaiKey: opts.openaiKey || undefined,
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
 * For image-only PDFs this returns an empty string — pdf-parse doesn't
 * OCR. parseResume() rejects empty extractions so the row is marked
 * failed rather than silently parsing as a blank candidate.
 */
export async function extractResumeText(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
): Promise<string> {
  const lower = (fileName || "").toLowerCase();
  const buffer = Buffer.from(fileBytes as any);

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
