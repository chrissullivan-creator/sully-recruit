import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared fuzzy person-matcher used by the inbox "Add" flow and the bulk
 * "reconcile unknown senders" sweep.
 *
 * Strategy: cheap broad retrieval in SQL (exact email / linkedin / phone, plus
 * last-name and company ilike), then score every candidate row in JS with a
 * Dice-coefficient bigram similarity over name, firm (company) and title. The
 * caller gets back a ranked list with a confidence band and the signals that
 * fired, so the UI can show "why" and decide between link-and-update vs create.
 */

// ── String similarity (Sørensen–Dice over character bigrams) ────────────────

export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Common company suffixes/noise stripped before comparing firms so
// "Millennium Management LLC" ≈ "Millennium Management".
const COMPANY_NOISE =
  /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|group|holdings|partners|capital|management|advisors|advisers|associates|the)\b/g;

export function normalizeCompany(s: string | null | undefined): string {
  return normalizeText(s).replace(COMPANY_NOISE, " ").replace(/\s+/g, " ").trim();
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient in [0,1]. 1 = identical, 0 = nothing in common. */
export function diceSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  let totalA = 0;
  for (const v of ba.values()) totalA += v;
  let totalB = 0;
  for (const v of bb.values()) totalB += v;
  for (const [g, countA] of ba) {
    const countB = bb.get(g);
    if (countB) overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / (totalA + totalB);
}

// ── Types ───────────────────────────────────────────────────────────────────

export type PersonRole = "candidate" | "client";

export interface MatchQuery {
  /** The role bucket the UI is adding into. We still search BOTH tables so a
   *  person who already exists in the other role is surfaced for dual-role. */
  type: PersonRole;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  company?: string | null;
  title?: string | null;
  limit?: number;
}

export type Confidence = "high" | "medium" | "low";

export interface ScoredMatch {
  id: string;
  type: PersonRole;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  title: string | null;
  company: string | null;
  // scoring detail
  score: number; // 0..1 overall
  confidence: Confidence;
  matched_on: string[]; // e.g. ['name','firm'] or ['email']
  name_sim: number;
  company_sim: number;
  title_sim: number;
  email_exact: boolean;
  linkedin_exact: boolean;
  phone_exact: boolean;
}

const SELECT_BASE =
  "id, first_name, last_name, full_name, email, work_email, personal_email, secondary_emails, phone, linkedin_url";
const SELECT_CAND = `${SELECT_BASE}, current_title, current_company`;
const SELECT_CONT = `${SELECT_BASE}, title, company_name`;

function rowTitle(row: any, type: PersonRole): string | null {
  return type === "candidate" ? row.current_title ?? null : row.title ?? null;
}
function rowCompany(row: any, type: PersonRole): string | null {
  return type === "candidate" ? row.current_company ?? null : row.company_name ?? null;
}
function rowEmails(row: any): string[] {
  const out: string[] = [];
  for (const e of [row.email, row.work_email, row.personal_email]) {
    if (e) out.push(String(e).toLowerCase());
  }
  if (Array.isArray(row.secondary_emails)) {
    for (const e of row.secondary_emails) if (e) out.push(String(e).toLowerCase());
  }
  return out;
}

// ── Retrieval + scoring ─────────────────────────────────────────────────────

/**
 * Returns up to `limit` ranked matches across candidates + contacts. Rows below
 * the low-confidence floor are dropped so callers only see plausible people.
 */
export async function findPersonMatches(
  supabase: SupabaseClient,
  q: MatchQuery,
): Promise<ScoredMatch[]> {
  const limit = q.limit ?? 5;
  const name = (q.name ?? "").trim();
  const email = q.email ? String(q.email).trim().toLowerCase() : "";
  const company = (q.company ?? "").trim();
  const title = (q.title ?? "").trim();
  const phoneDigits = q.phone ? String(q.phone).replace(/\D/g, "") : "";
  const liSlug = q.linkedin_url
    ? q.linkedin_url.replace(/\/$/, "").split("?")[0].toLowerCase().split("/in/")[1] ?? ""
    : "";

  const parts = name.split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";

  // Pull a broad candidate pool from one table.
  const retrieve = async (table: "candidates" | "contacts") => {
    const sel = table === "candidates" ? SELECT_CAND : SELECT_CONT;
    const rowsById = new Map<string, any>();
    const add = (data: any[] | null) => {
      for (const r of data ?? []) if (!rowsById.has(r.id)) rowsById.set(r.id, r);
    };

    const queries: Promise<any>[] = [];
    if (email) {
      queries.push(
        supabase
          .from(table)
          .select(sel)
          .or(
            `email.ilike.${email},work_email.ilike.${email},personal_email.ilike.${email},secondary_emails.cs.{${email}}`,
          )
          .limit(5)
          .then((r) => add(r.data)),
      );
    }
    if (liSlug) {
      queries.push(
        supabase.from(table).select(sel).ilike("linkedin_url", `%${liSlug}%`).limit(5).then((r) => add(r.data)),
      );
    }
    if (phoneDigits.length >= 7) {
      queries.push(
        supabase
          .from(table)
          .select(sel)
          .ilike("phone", `%${phoneDigits.slice(-7)}%`)
          .limit(5)
          .then((r) => add(r.data)),
      );
    }
    // Name retrieval — last name is the stable token; widen with first name.
    if (lastName) {
      queries.push(
        supabase.from(table).select(sel).ilike("last_name", `%${lastName}%`).limit(40).then((r) => add(r.data)),
      );
    } else if (firstName.length > 2) {
      queries.push(
        supabase.from(table).select(sel).ilike("first_name", `%${firstName}%`).limit(40).then((r) => add(r.data)),
      );
    }
    // Company retrieval helps confirm same-firm people even when the name
    // typed differs slightly.
    if (company.length > 2) {
      const col = table === "candidates" ? "current_company" : "company_name";
      queries.push(
        supabase.from(table).select(sel).ilike(col, `%${company}%`).limit(40).then((r) => add(r.data)),
      );
    }

    await Promise.all(queries);
    return Array.from(rowsById.values());
  };

  const [candRows, contRows] = await Promise.all([retrieve("candidates"), retrieve("contacts")]);

  const scoreRows = (rows: any[], type: PersonRole): ScoredMatch[] =>
    rows.map((row) => {
      const rName = row.full_name || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
      const rCompany = rowCompany(row, type);
      const rTitle = rowTitle(row, type);

      const name_sim = name ? diceSimilarity(name, rName) : 0;
      const company_sim =
        company && rCompany ? diceSimilarity(normalizeCompany(company), normalizeCompany(rCompany)) : 0;
      const title_sim = title && rTitle ? diceSimilarity(title, rTitle) : 0;

      const emails = rowEmails(row);
      const email_exact = !!email && emails.includes(email);
      const linkedin_exact =
        !!liSlug && !!row.linkedin_url && String(row.linkedin_url).toLowerCase().includes(liSlug);
      const phone_exact =
        phoneDigits.length >= 7 &&
        !!row.phone &&
        String(row.phone).replace(/\D/g, "").endsWith(phoneDigits.slice(-7));

      // Weighted blend of the fuzzy signals (renormalized to the ones we
      // actually have data for), with hard signals pinning the score high.
      let weightSum = 0;
      let acc = 0;
      const addSig = (w: number, v: number) => {
        weightSum += w;
        acc += w * v;
      };
      addSig(0.6, name_sim);
      if (company) addSig(0.25, company_sim);
      if (title) addSig(0.15, title_sim);
      let score = weightSum > 0 ? acc / weightSum : 0;
      if (email_exact || linkedin_exact || phone_exact) score = Math.max(score, 0.95);

      // Confidence band + which signals to credit.
      const matched_on: string[] = [];
      if (email_exact) matched_on.push("email");
      if (linkedin_exact) matched_on.push("linkedin");
      if (phone_exact) matched_on.push("phone");
      if (name_sim >= 0.6) matched_on.push("name");
      if (company_sim >= 0.6) matched_on.push("firm");
      if (title_sim >= 0.6) matched_on.push("title");

      let confidence: Confidence = "low";
      if (email_exact || linkedin_exact || phone_exact) {
        confidence = "high";
      } else if (name_sim >= 0.82 && (company_sim >= 0.6 || title_sim >= 0.6)) {
        confidence = "high";
      } else if (name_sim >= 0.82) {
        confidence = "medium";
      } else if (name_sim >= 0.62) {
        confidence = "low";
      }

      return {
        id: row.id,
        type,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        full_name: row.full_name ?? null,
        email: row.email ?? row.work_email ?? row.personal_email ?? null,
        linkedin_url: row.linkedin_url ?? null,
        phone: row.phone ?? null,
        title: rTitle,
        company: rCompany,
        score,
        confidence,
        matched_on,
        name_sim,
        company_sim,
        title_sim,
        email_exact,
        linkedin_exact,
        phone_exact,
      };
    });

  const all = [...scoreRows(candRows, "candidate"), ...scoreRows(contRows, "contact" as any)];

  // Keep only plausible rows: a hard signal, or a name that's at least a
  // weak match. Everything else is noise from the broad company/last-name pull.
  const plausible = all.filter(
    (m) => m.email_exact || m.linkedin_exact || m.phone_exact || m.name_sim >= 0.62,
  );

  // Rank: hard signals first, then score, then name similarity.
  plausible.sort((a, b) => {
    const ah = a.email_exact || a.linkedin_exact || a.phone_exact ? 1 : 0;
    const bh = b.email_exact || b.linkedin_exact || b.phone_exact ? 1 : 0;
    if (ah !== bh) return bh - ah;
    if (b.score !== a.score) return b.score - a.score;
    return b.name_sim - a.name_sim;
  });

  // Dedupe by id+type (a person can legitimately appear as both roles).
  const seen = new Set<string>();
  const deduped: ScoredMatch[] = [];
  for (const m of plausible) {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
    if (deduped.length >= limit) break;
  }
  return deduped;
}
