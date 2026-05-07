/**
 * Single source of truth for resume parsing.
 *
 * Strategy: send the file straight to Affinda via Eden AI's universal-ai
 * endpoint (model = "ocr/resume_parser/affinda"). Affinda is a
 * purpose-built resume parser that:
 *   - Handles native PDFs (text layer)
 *   - OCRs scanned / image-only PDFs (the long tail that pdf-parse +
 *     LLM-on-text approaches choke on — exactly what was leaving 180+
 *     of our bulk-drop résumés stuck)
 *   - Handles DOCX/DOC natively
 *   - Returns structured data — no prompt engineering, no JSON-parse
 *     fragility
 *
 * Used by:
 *   - frontend/api/parse-resume.ts          (Vercel — interactive AddCandidate)
 *   - frontend/src/trigger/resume-ingestion.ts          (Trigger — bulk-drop / inbox)
 *   - frontend/src/trigger/reconcile-orphaned-resumes.ts (Trigger — reconcile)
 *   - frontend/src/trigger/reparse-resumes.ts            (Trigger — reparse)
 *
 * Both Vercel and Trigger.dev run Node 20+ with global fetch / Buffer.
 */

/**
 * Eden v3 universal-ai accepts JSON but its file-input shape for
 * the resume_parser model is poorly documented and rejected every
 * JSON variant we tried (file_base64 + file_name + file_type, then
 * `file` as data URI — both 422'd with "field 'file' is required").
 *
 * The well-documented Eden path for resume parsing is the v2 multipart
 * form-data endpoint, identical to uploading from a browser
 * <input type=file>. That's what we use here.
 */
const EDEN_URL = "https://api.edenai.run/v2/ocr/resume_parser";
const EDEN_PROVIDER = "affinda";

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
  /** Best-effort raw text Affinda surfaced from the file (or empty). */
  rawText: string | null;
  via: "affinda";
}

export interface ParseResumeOptions {
  edenKey: string;
  log?: { warn: (msg: string, meta?: any) => void };
}

function getMimeType(fileName: string): string {
  const l = (fileName || "").toLowerCase();
  if (l.endsWith(".pdf")) return "application/pdf";
  if (l.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (l.endsWith(".doc")) return "application/msword";
  if (l.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function toBase64(input: ArrayBuffer | Uint8Array): string {
  return Buffer.from(input as any).toString("base64");
}

function firstNonEmpty(arr: any[]): string {
  for (const v of arr) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v?.value && String(v.value).trim()) return String(v.value).trim();
    if (v?.email && String(v.email).trim()) return String(v.email).trim();
    if (v?.phone && String(v.phone).trim()) return String(v.phone).trim();
    if (v?.url && String(v.url).trim()) return String(v.url).trim();
  }
  return "";
}

/**
 * Map Affinda's `extracted_data` shape (as returned by Eden) to our flat
 * candidate schema. Defensive about field names — Eden has shifted shapes
 * more than once.
 */
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  // Affinda occasionally returns a single object instead of an array
  // (e.g. one-job résumés with `work_experience: { ... }`). Wrap it.
  return [v];
}

function mapAffindaOutput(output: any): ParsedResume {
  const ed = output?.extracted_data ?? output ?? {};
  const personal = ed.personal_infos ?? ed.personalInfos ?? {};
  const work = asArray(ed.work_experience ?? ed.workExperience ?? ed.experiences);
  const skillsRaw = asArray(ed.skills);
  const name = personal.name ?? {};

  let firstName = name.first_name ?? name.firstName ?? name.first ?? "";
  let lastName = name.last_name ?? name.lastName ?? name.last ?? "";
  if (!firstName && !lastName) {
    const raw = name.raw_name ?? name.rawName ?? name.full_name ?? name.fullName ?? "";
    if (raw) {
      const parts = String(raw).trim().split(/\s+/);
      firstName = parts[0] || "";
      lastName = parts.slice(1).join(" ") || "";
    }
  }

  const mails = asArray(personal.mails ?? personal.emails ?? ed.emails);
  const phones = asArray(personal.phones ?? ed.phones);
  const urls: any[] = asArray(personal.urls ?? ed.urls);

  let linkedinUrl = "";
  for (const u of urls) {
    const v = typeof u === "string" ? u : (u?.url ?? u?.value ?? "");
    if (v && /linkedin\.com/i.test(v)) { linkedinUrl = v; break; }
  }

  const address = personal.address ?? {};
  const location =
    address.formatted_location ??
    address.formattedLocation ??
    [address.city, address.state, address.country].filter(Boolean).join(", ") ??
    "";

  // Most-recent experience: prefer is_current, else first entry.
  const sortedWork = [...(work || [])];
  const cur = sortedWork.find((w) => w?.is_current || w?.isCurrent) ?? sortedWork[0] ?? {};
  const current_title = cur.title ?? cur.job_title ?? cur.role ?? cur.position ?? "";
  const current_company = cur.company ?? cur.employer ?? cur.organization ?? cur.organisation ?? "";

  const skills = skillsRaw
    .map((s) => (typeof s === "string" ? s : s?.name ?? s?.skill ?? ""))
    .filter((s: any) => typeof s === "string" && s.trim())
    .slice(0, 25);

  return {
    first_name: firstName,
    last_name: lastName,
    email: firstNonEmpty(mails),
    phone: firstNonEmpty(phones),
    linkedin_url: linkedinUrl,
    location,
    current_title,
    current_company,
    skills,
  };
}

/**
 * Best-effort: extract a raw text representation from Affinda's response
 * so downstream code (Voyage embedding, sanity-check) has something to
 * work with. Affinda exposes either `text` or assembled per-section
 * blobs depending on provider settings.
 */
function extractRawTextFromOutput(output: any): string {
  const direct = output?.text ?? output?.raw_text ?? output?.rawText;
  if (typeof direct === "string" && direct.length > 50) return direct.slice(0, 16_000);

  const ed = output?.extracted_data ?? output ?? {};
  const lines: string[] = [];
  const personal = ed.personal_infos ?? ed.personalInfos ?? {};
  if (personal.name?.raw_name) lines.push(personal.name.raw_name);
  if (Array.isArray(ed.summary)) lines.push(...ed.summary);
  else if (typeof ed.summary === "string") lines.push(ed.summary);

  for (const w of asArray(ed.work_experience ?? ed.workExperience)) {
    lines.push([w?.title, w?.company].filter(Boolean).join(" — "));
    if (w?.description) lines.push(String(w.description));
  }
  for (const e of asArray(ed.education)) {
    lines.push([e?.establishment, e?.title, e?.dates?.from?.text].filter(Boolean).join(" · "));
  }
  return lines.join("\n").slice(0, 16_000);
}

/**
 * Parse a resume via Eden AI's universal Affinda model. Throws on
 * non-success Eden response — callers treat that as a fatal parse
 * failure (no further fallback configured).
 */
export async function parseResume(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
  opts: ParseResumeOptions,
): Promise<ParseResumeResult> {
  if (!opts.edenKey) throw new Error("EDEN_AI_API_KEY missing");

  const mime = getMimeType(fileName);
  // Node 20+ has Blob and FormData as globals.
  const blob = new Blob([fileBytes as any], { type: mime });
  const fd = new FormData();
  fd.append("providers", EDEN_PROVIDER);
  fd.append("file", blob, fileName);

  const resp = await fetch(EDEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.edenKey}`,
      // Don't set Content-Type — fetch fills in the multipart boundary.
    },
    body: fd,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Eden ${resp.status}: ${text.slice(0, 300)}`);
  }

  let data: any;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Eden non-JSON response: ${text.slice(0, 200)}`);
  }

  // v2 envelopes the result by provider name:
  //   { affinda: { status, extracted_data, ... } }
  const providerBlock = data?.[EDEN_PROVIDER] ?? data;
  if (providerBlock?.status && providerBlock.status !== "success") {
    throw new Error(
      `Eden ${providerBlock.status}: ${JSON.stringify(providerBlock.error ?? providerBlock).slice(0, 300)}`,
    );
  }

  const parsed = mapAffindaOutput(providerBlock);
  const rawText = extractRawTextFromOutput(providerBlock);

  return { parsed, rawText: rawText || null, via: "affinda" };
}

/**
 * Standalone text extraction. Kept for callers that want a `raw_text`
 * column without running the full parseResume (e.g. the resume-ingestion
 * sanity check). Production paths should prefer parseResume()'s rawText.
 *
 * For image-only PDFs this returns an empty string — Affinda inside
 * parseResume() OCRs them; this helper does not.
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
