/**
 * Single source of truth for resume parsing.
 *
 * Used by:
 *   - frontend/api/parse-resume.ts          (Vercel — interactive AddCandidate flow)
 *   - frontend/src/trigger/resume-ingestion.ts          (Trigger — bulk-drop / inbox)
 *   - frontend/src/trigger/lib/resume-parsing.ts        (Trigger — reconcile / reparse)
 *
 * Each used to maintain its own copy of:
 *   - PDF/DOCX text extraction
 *   - Claude system prompt
 *   - Claude → OpenAI fallback regex
 *   - JSON parsing of model output
 *
 * Bugs (e.g. PDF placeholder bypassing OpenAI fallback) had to be patched in
 * three places. This module owns all of it. Both Vercel and Trigger.dev run
 * Node 20+ with global fetch, so no env-specific imports here.
 */

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const OPENAI_FALLBACK_MODEL = "gpt-4o-mini";

export const RESUME_SYSTEM_PROMPT = `You are a resume parser for The Emerald Recruiting Group, a Wall Street staffing firm. Extract structured candidate data from resumes with precision.

Return ONLY a raw JSON object — no markdown fences, no backticks, no preamble. Just the JSON:
{
  "first_name": "",
  "last_name": "",
  "email": "",
  "phone": "",
  "linkedin_url": "",
  "location": "",
  "current_title": "",
  "current_company": "",
  "skills": []
}

Rules:
- Use empty string for unknown fields, empty array for no skills
- Extract up to 25 most relevant skills
- current_title and current_company: most recent role only`;

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
  /** Parsed structured fields. Empty object if model returned no JSON. */
  parsed: ParsedResume;
  /** Best-effort raw text extracted from the file. Null only when extraction failed. */
  rawText: string | null;
  /** Which provider produced the answer. */
  via: "claude" | "openai";
}

export interface ParseResumeOptions {
  anthropicKey: string;
  /** When provided, used as fallback on credit/rate/auth errors. */
  openaiKey?: string;
  /** Optional logger for warnings (Trigger.dev's `logger`, console, etc.). */
  log?: { warn: (msg: string, meta?: any) => void };
  /** Override timeout for pdf-parse (ms). Default 20s. */
  pdfTimeoutMs?: number;
}

const FALLBACK_REGEX =
  /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key|overloaded/i;

function isFallbackable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return FALLBACK_REGEX.test(msg);
}

function getExt(s: string): "pdf" | "docx" | "doc" | "txt" | "other" {
  const l = (s || "").toLowerCase();
  if (l.endsWith(".pdf")) return "pdf";
  if (l.endsWith(".docx")) return "docx";
  if (l.endsWith(".doc")) return "doc";
  if (l.endsWith(".txt")) return "txt";
  return "other";
}

function toBuffer(input: ArrayBuffer | Uint8Array): Buffer {
  return Buffer.from(input as any);
}

function toBase64(input: ArrayBuffer | Uint8Array): string {
  return toBuffer(input).toString("base64");
}

/**
 * Best-effort text extraction. Always returns a string — empty string when
 * we genuinely have nothing (we never return placeholder strings like
 * "[PDF - ...]" because they used to silently bypass OpenAI fallback).
 */
export async function extractResumeText(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
  opts?: { pdfTimeoutMs?: number; log?: ParseResumeOptions["log"] },
): Promise<string> {
  const ext = getExt(fileName);
  const buffer = toBuffer(fileBytes);

  if (ext === "txt") {
    return new TextDecoder().decode(buffer).slice(0, 16_000);
  }

  if (ext === "docx") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.default.extractRawText({ buffer });
      return (result.value || "").trim().slice(0, 16_000);
    } catch (err: any) {
      opts?.log?.warn("DOCX extract failed", { fileName, error: err?.message });
      return "";
    }
  }

  if (ext === "doc") {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    const readable = decoded.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
    return readable.length > 50 ? readable.slice(0, 16_000) : "";
  }

  if (ext === "pdf") {
    try {
      // Inner module path skips pdf-parse's top-level test-fixture autorun.
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const timeoutMs = opts?.pdfTimeoutMs ?? 20_000;
      const result = await Promise.race([
        pdfParse(buffer),
        new Promise<{ text: string }>((_, rej) =>
          setTimeout(() => rej(new Error(`pdf-parse timeout ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      return (result.text || "").trim().slice(0, 16_000);
    } catch (err: any) {
      opts?.log?.warn("PDF extract failed", { fileName, error: err?.message });
      return "";
    }
  }

  return new TextDecoder().decode(buffer).slice(0, 16_000);
}

/** Pull the first valid JSON object from a model response. */
function extractJson(text: string): ParsedResume {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return {};
  }
}

async function parseViaClaude(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
  rawText: string,
  apiKey: string,
): Promise<ParsedResume> {
  const ext = getExt(fileName);
  const useDocumentBlock = ext === "pdf";

  const userContent = useDocumentBlock
    ? [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: toBase64(fileBytes) },
        },
        { type: "text", text: "Parse this resume and return the JSON." },
      ]
    : `Resume text:\n\n${rawText.slice(0, 30_000)}\n\nParse and return the JSON.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: RESUME_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
  return extractJson(text);
}

async function parseViaOpenAI(
  rawText: string,
  fileName: string,
  apiKey: string,
): Promise<ParsedResume> {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_FALLBACK_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RESUME_SYSTEM_PROMPT },
        { role: "user", content: `Parse this resume (${fileName}):\n\n${rawText.slice(0, 16_000)}` },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  return extractJson(text);
}

/**
 * Parse a resume file. PDFs prefer Claude's native document block; DOCX/DOC/TXT
 * route through the text path. On Claude credit-balance / rate / auth errors,
 * falls back to OpenAI gpt-4o-mini using extracted text — but only if we
 * actually have text (PDFs whose text extractor produced nothing will surface
 * the original Claude error rather than send a junk prompt).
 */
export async function parseResume(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
  opts: ParseResumeOptions,
): Promise<ParseResumeResult> {
  // Always try to extract text first — used both as an OpenAI input on
  // fallback AND as raw_text we want to persist.
  const rawText = await extractResumeText(fileBytes, fileName, {
    pdfTimeoutMs: opts.pdfTimeoutMs,
    log: opts.log,
  });

  let claudeErr: unknown = null;
  try {
    const parsed = await parseViaClaude(fileBytes, fileName, rawText, opts.anthropicKey);
    return { parsed, rawText: rawText || null, via: "claude" };
  } catch (err) {
    claudeErr = err;
  }

  if (!opts.openaiKey || !isFallbackable(claudeErr)) throw claudeErr;
  if (!rawText || rawText.length < 50) throw claudeErr;

  opts.log?.warn?.("Claude failed, falling back to OpenAI", {
    fileName,
    error: claudeErr instanceof Error ? claudeErr.message : String(claudeErr),
  });
  const parsed = await parseViaOpenAI(rawText, fileName, opts.openaiKey);
  return { parsed, rawText, via: "openai" };
}
