import { logger } from "./logger.js";
import { getVoyageKey } from "./supabase.js";
import { fetchWithRetry } from "./fetch-retry.js";

const VOYAGE_MODEL = "voyage-finance-2";

/**
 * Trigger-side utilities used across the resume pipeline. The actual
 * parser (Claude → OpenAI fallback + PDF text extraction) lives in
 * `frontend/src/lib/resume-parser.ts` so Vercel functions and
 * Trigger.dev tasks share a single implementation. This file owns the
 * helpers around it: junk-file heuristic, Voyage embedding, and small
 * normalisers.
 */

// Anchored against the full filename so we only catch purely-numeric
// IDs like `1234567890_42.pdf` — not uploader-prefixed legitimate names
// like `1778645907582_7sud_Kevin_Dwyernewresume.pdf` where `7sud` is a
// random 4-char suffix that happens to start with a digit.
const JUNK_PATTERNS = [
  /invoice/i, /receipt/i, /confirmation/i, /waiver/i,
  /order[_\s-]?id/i, /\bform\b/i, /\bsigned\b/i,
  /\bagreement\b/i, /\bcontract\b/i, /offer[_\s-]?letter/i,
  /cover[_\s-]?letter/i, /\breference/i, /\btranscript\b/i,
  /\bdegree\b/i, /\bcertif/i, /\blicense\b/i,
  /emerald.recruiting/i, /fiera/i, /\bpitch\b/i,
  /\bproposal\b/i, /\bpresentation\b/i, /\bmarketing\b/i,
  /^\d{8,}_\d+\.(pdf|docx?|txt)$/i, /^[a-f0-9-]{32,}\.pdf$/i,
];

export function looksLikeResume(fileName: string): boolean {
  const lower = (fileName || "").toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".docx") && !lower.endsWith(".doc")) return false;
  for (const p of JUNK_PATTERNS) {
    if (p.test(fileName)) return false;
  }
  return true;
}

/**
 * Embed text with Voyage AI (voyage-finance-2).
 */
export async function getVoyageEmbedding(text: string): Promise<number[]> {
  const apiKey = await getVoyageKey();
  const res = await fetchWithRetry("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  }, { label: "voyage" });
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

// Suppress unused-import warning for `logger` in environments that don't
// statically detect it; consumers can still use it from @trigger.dev/sdk.
void logger;
