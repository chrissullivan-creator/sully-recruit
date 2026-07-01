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
// NOTE: `emerald.recruiting` and `fiera` were REMOVED (2026-07-01). They were
// meant to drop the firm's own marketing decks, but Emerald house-formatted
// résumés are branded "Emerald Recruiting Group" (and Fiera is a real employer),
// so those two patterns silently rejected legitimate candidate résumés on the
// async crons — while the in-app upload path (no filename filter) parsed them
// fine. Losing a candidate is far worse than wasting a few cents of AI tokens on
// a stray marketing PDF, so we no longer filename-reject on brand words.
const JUNK_PATTERNS = [
  /invoice/i, /receipt/i, /confirmation/i, /waiver/i,
  /order[_\s-]?id/i, /\bform\b/i, /\bsigned\b/i,
  /\bagreement\b/i, /\bcontract\b/i, /offer[_\s-]?letter/i,
  /cover[_\s-]?letter/i, /\breference/i, /\btranscript\b/i,
  /\bdegree\b/i, /\bcertif/i, /\blicense\b/i,
  /\bpitch\b/i,
  /\bproposal\b/i, /\bpresentation\b/i, /\bmarketing\b/i,
  /^\d{8,}_\d+\.(pdf|docx?|txt)$/i, /^[a-f0-9-]{32,}\.pdf$/i,
];

/**
 * Canonical FILENAME heuristic — is this file *named* like a résumé (right
 * extension, not an obvious junk doc)? Cheap pre-download gate used by the
 * reconcile / reparse sweeps. There is a second, TEXT-based heuristic below
 * (`textLooksLikeResume`) for post-extraction content sniffing — keep the two
 * distinct; conflating them is what produced three divergent copies.
 *
 * A Deno mirror of this lives in the `reconcile-orphaned-resumes` edge function
 * (it can't import from `src/`); keep the two JUNK_PATTERNS lists in sync.
 */
export function filenameLooksLikeResume(fileName: string): boolean {
  const lower = (fileName || "").toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".docx") && !lower.endsWith(".doc")) return false;
  for (const p of JUNK_PATTERNS) {
    if (p.test(fileName)) return false;
  }
  return true;
}

/**
 * Canonical TEXT heuristic — after extraction, does the content look like a
 * résumé? The bar is intentionally low: false positives waste a few cents of AI
 * tokens, false negatives lose a candidate, so we only reject when the text is
 * too short AND has no email AND no résumé-shaped keyword. Moved here from
 * `resume-ingestion.ts` so ingestion, reparse, and reconcile share one copy.
 */
export function textLooksLikeResume(rawText: string): boolean {
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
  return hasEmail || hasKeyword;
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
