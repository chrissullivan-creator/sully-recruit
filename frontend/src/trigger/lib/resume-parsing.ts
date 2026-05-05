import { logger } from "@trigger.dev/sdk/v3";
import { getAnthropicKey, getOpenAIKey, getVoyageKey } from "./supabase";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const OPENAI_FALLBACK_MODEL = "gpt-4o-mini";
const VOYAGE_MODEL = "voyage-finance-2";

// Errors where retrying Claude won't help — fall back to OpenAI.
const FALLBACKABLE = /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key/i;

export const RESUME_SYSTEM = `You are a resume parser for The Emerald Recruiting Group, a Wall Street staffing firm. Extract structured candidate data from resumes with precision.

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

const JUNK_PATTERNS = [
  /invoice/i, /receipt/i, /confirmation/i, /waiver/i,
  /order[_\s-]?id/i, /\bform\b/i, /\bsigned\b/i,
  /\bagreement\b/i, /\bcontract\b/i, /offer[_\s-]?letter/i,
  /cover[_\s-]?letter/i, /\breference/i, /\btranscript\b/i,
  /\bdegree\b/i, /\bcertif/i, /\blicense\b/i,
  /emerald.recruiting/i, /fiera/i, /\bpitch\b/i,
  /\bproposal\b/i, /\bpresentation\b/i, /\bmarketing\b/i,
  /^\d{8,}_\d+/, /^[a-f0-9-]{32,}\.pdf$/i,
];

export function looksLikeResume(fileName: string): boolean {
  const lower = (fileName || "").toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".docx") && !lower.endsWith(".doc")) return false;
  for (const p of JUNK_PATTERNS) {
    if (p.test(fileName)) return false;
  }
  return true;
}

function getExtension(s: string): "pdf" | "docx" | "doc" {
  const l = (s || "").toLowerCase();
  if (l.endsWith(".pdf")) return "pdf";
  if (l.endsWith(".docx")) return "docx";
  return "doc";
}

export function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64");
}

export async function extractDocxText(buf: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.default.extractRawText({ buffer: Buffer.from(buf) });
  const rawText = (result.value || "").trim();
  if (!rawText) throw new Error("Empty text from DOCX");
  return rawText;
}

function parseClaudeResponse(raw: any): any {
  const text = raw?.content?.[0]?.text;
  if (!text) throw new Error("Claude missing content");
  return JSON.parse(text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim());
}

async function parseTextWithOpenAI(rawText: string, fileName: string, apiKey: string): Promise<any> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_FALLBACK_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RESUME_SYSTEM },
        { role: "user", content: `Parse this resume (${fileName}):\n\n${rawText.slice(0, 16000)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  try { return JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("OpenAI returned non-JSON"); }
}

/**
 * Parse a resume file (PDF or DOCX) with Claude. Returns parsed JSON + raw text.
 * `fileBytes` is the raw file content as ArrayBuffer.
 *
 * Falls back to OpenAI (gpt-4o-mini) when Claude returns a "won't recover"
 * error (credit balance, rate limit, auth) AND we have already-extracted
 * text. PDFs without a fallback path still throw — Claude is the only
 * native PDF parser here.
 */
export async function parseWithClaude(
  fileBytes: ArrayBuffer,
  fileName: string,
): Promise<{ parsed: any; rawText: string | null }> {
  const ext = getExtension(fileName);
  const anthropicKey = await getAnthropicKey();

  if (ext === "pdf") {
    const header = new Uint8Array(fileBytes.slice(0, 4));
    if (!(header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46)) {
      throw new Error("Invalid PDF header");
    }
    const b64 = toBase64(fileBytes);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: RESUME_SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: "Parse this resume and return the JSON." },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { parsed: parseClaudeResponse(await res.json()), rawText: null };
  }

  // DOCX / DOC — extract text first so we can fall back to OpenAI.
  const rawText = await extractDocxText(fileBytes);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: RESUME_SYSTEM,
        messages: [{
          role: "user",
          content: `Resume text:\n\n${rawText.slice(0, 30000)}\n\nParse and return the JSON.`,
        }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { parsed: parseClaudeResponse(await res.json()), rawText };
  } catch (claudeErr: any) {
    const msg = String(claudeErr?.message || "");
    if (!FALLBACKABLE.test(msg)) throw claudeErr;
    const openAiKey = await getOpenAIKey();
    if (!openAiKey) throw claudeErr;
    logger.warn("Claude failed in lib/parseWithClaude, falling back to OpenAI", { error: msg });
    const parsed = await parseTextWithOpenAI(rawText, fileName, openAiKey);
    return { parsed, rawText };
  }
}

/**
 * Embed text with Voyage AI (voyage-finance-2).
 */
export async function getVoyageEmbedding(text: string): Promise<number[]> {
  const apiKey = await getVoyageKey();
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data[0].embedding;
}

/**
 * Build a rich text profile for embedding from candidate data + parsed resume.
 */
export function buildProfileText(
  candidate: { full_name?: string; current_title?: string; current_company?: string; location_text?: string; skills?: string[] },
  rawText: string | null,
  parsed: any,
): string {
  const parts: string[] = [];
  if (candidate.full_name) parts.push(`Name: ${candidate.full_name}`);
  if (candidate.current_title || parsed?.current_title)
    parts.push(`Current Title: ${candidate.current_title || parsed.current_title}`);
  if (candidate.current_company || parsed?.current_company)
    parts.push(`Current Company: ${candidate.current_company || parsed.current_company}`);
  if (candidate.location_text || parsed?.location)
    parts.push(`Location: ${candidate.location_text || parsed.location}`);
  const skills = candidate.skills?.length ? candidate.skills : parsed?.skills;
  if (skills?.length) parts.push(`Skills: ${skills.join(", ")}`);
  if (rawText) parts.push(`Resume:\n${rawText.slice(0, 20000)}`);
  return parts.join("\n\n");
}

export function normalizeEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const v = e.trim().toLowerCase();
  return v || null;
}

export function normalizeLinkedIn(u: string | null | undefined): string | null {
  if (!u) return null;
  const m = String(u).match(/linkedin\.com\/in\/([^/?\s#]+)/);
  return m ? m[1].toLowerCase().replace(/\/+$/, "") : null;
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
