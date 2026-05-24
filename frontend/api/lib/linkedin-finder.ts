/**
 * LinkedIn discovery + profile-fetch helpers used by the synchronous
 * `/api/people/enrich` endpoint when the recruiter ticks "LinkedIn
 * profile & work history".
 *
 * Two-step pipeline:
 *   1. findLinkedinUrlForPerson  — search by name+company when the
 *      person has no linkedin_url. Tries Apollo /people/match first,
 *      then Unipile recruiter search. Returns the URL without writing.
 *   2. fetchUnipileProfile       — once a URL exists, fetch the full
 *      profile via Unipile v1 /users/{slug}?account_id=X.
 *   3. applyLinkedinProfileToPerson — write the profile back to the
 *      `people` row and replace candidate_work_history rows from the
 *      profile's work_experience array.
 *
 * The Inngest function `find-linkedin-url-by-name` keeps its own copy
 * of the conservative discovery logic — it runs in the background with
 * concurrency guards. This helper is the synchronous, user-triggered
 * sibling. Keep them in sync if the matching heuristics change.
 */
import { unipileFetch } from "../../src/server-lib/unipile-v2.js";
import { getApolloConfig, apolloMatchPerson } from "./integrations/apollo.js";

const NAME_SIM_APOLLO = 0.85;
const NAME_SIM_UNIPILE_PRIMARY = 0.92;
const NAME_SIM_UNIPILE_AMBIGUOUS = 0.85;

export interface PersonForLinkedinSearch {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name?: string | null;
  current_company: string | null;
  primary_email?: string | null;
  work_email?: string | null;
  personal_email?: string | null;
}

export interface FindLinkedinUrlResult {
  url: string;
  source: "apollo" | "unipile";
  score?: number;
}

export interface ApplyLinkedinResult {
  /** Names of `people` columns that were actually written. */
  fieldsUpdated: string[];
  /** Number of candidate_work_history rows inserted (after replace). */
  workHistoryRows: number;
}

interface SearchHit {
  name: string;
  profile_url: string | null;
  public_identifier: string | null;
  current_company: string | null;
}

/* ───────────────────────────── public API ────────────────────────────── */

/**
 * Find a LinkedIn URL for a person who doesn't have one yet. Apollo
 * first (cheap, fast), Unipile recruiter search as fallback. Returns
 * null when no high-confidence match was found.
 *
 * Does NOT write anything — caller is responsible for persisting.
 */
export async function findLinkedinUrlForPerson(
  supabase: any,
  person: PersonForLinkedinSearch,
): Promise<FindLinkedinUrlResult | null> {
  const fullName = buildFullName(person);
  if (!fullName) return null;

  // ── Apollo primary ───────────────────────────────────────────────
  try {
    const apolloConfig = await getApolloConfig(supabase);
    if (apolloConfig) {
      const match = await apolloMatchPerson(apolloConfig, {
        first_name: person.first_name || undefined,
        last_name: person.last_name || undefined,
        name: !person.first_name && !person.last_name ? fullName : undefined,
        organization_name: person.current_company || undefined,
        email: person.primary_email || person.work_email || person.personal_email || undefined,
      });
      if (match?.linkedin_url) {
        const apolloName = match.name
          ?? `${match.first_name ?? ""} ${match.last_name ?? ""}`.trim();
        const sim = nameSimilarity(fullName, apolloName);
        if (sim >= NAME_SIM_APOLLO) {
          return { url: match.linkedin_url, source: "apollo", score: sim };
        }
      }
    }
  } catch {
    // Apollo errors are non-fatal — fall through to Unipile.
  }

  // ── Unipile recruiter search fallback ────────────────────────────
  const account = await pickRecruiterAccount(supabase);
  if (!account) return null;

  let hits: SearchHit[] = [];
  try {
    hits = await runRecruiterSearch(
      supabase,
      account.unipile_account_id,
      fullName,
      person.current_company,
    );
  } catch {
    return null;
  }
  if (hits.length === 0) return null;

  const scored = hits
    .map((hit) => ({ hit, score: scoreHit(hit, fullName, person.current_company) }))
    .sort((a, b) => b.score.total - a.score.total);

  const best = scored[0];
  const second = scored[1];
  if (best.score.total < NAME_SIM_UNIPILE_PRIMARY) return null;
  // Two strong matches → ambiguous. Skip rather than risk a wrong URL.
  if (second && second.score.total >= NAME_SIM_UNIPILE_AMBIGUOUS) return null;

  const url = best.hit.profile_url
    ?? (best.hit.public_identifier
        ? `https://www.linkedin.com/in/${best.hit.public_identifier}`
        : null);
  if (!url) return null;

  return { url, source: "unipile", score: best.score.total };
}

/**
 * Fetch a LinkedIn profile via Unipile v1. Accepts a slug or full URL;
 * extracts the slug and calls /users/{slug}?account_id=X.
 *
 * Returns the raw Unipile profile JSON, or null if the lookup failed
 * (no active LinkedIn account, 4xx from Unipile, etc.).
 */
export async function fetchUnipileProfile(
  supabase: any,
  linkedinUrl: string,
): Promise<any | null> {
  const slug = asLinkedinSlug(linkedinUrl) ?? linkedinUrl;
  if (!slug) return null;

  const account = await pickAnyLinkedinAccount(supabase);
  if (!account) return null;

  try {
    // unipileFetch translates `linkedin/users/{slug}` → v1 `users/{slug}`
    // and appends account_id as a query param.
    return await unipileFetch(supabase, account.unipile_account_id, `linkedin/users/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

/**
 * Apply a Unipile profile to a person row.
 *   - Writes flat current_* fields when ours are empty or stale.
 *   - Stamps linkedin_* mirror columns + linkedin_last_synced_at.
 *   - Replaces candidate_work_history rows from the profile's
 *     work_experience array (delete + insert — simpler than reconciling).
 *
 * Returns the names of `people` columns that were actually changed so
 * the caller can report what happened.
 */
export async function applyLinkedinProfileToPerson(
  supabase: any,
  personId: string,
  profileData: any,
  currentRow: any,
): Promise<ApplyLinkedinResult> {
  const updated: string[] = [];
  const updates: Record<string, any> = {};

  // ── Pick the "current" experience: profile may expose either the
  //    experience[]/work_experience[] arrays or flat current_* fields.
  const expArray =
    (Array.isArray(profileData?.experience) && profileData.experience)
    || (Array.isArray(profileData?.work_experience) && profileData.work_experience)
    || [];
  const currentExp = expArray.length > 0 ? expArray[0] : null;

  const currentTitle = pickString(
    currentExp?.title,
    currentExp?.position,
    profileData?.current_position,
    profileData?.current_title,
    profileData?.title,
  );
  const currentCompany = pickString(
    typeof currentExp?.company === "string" ? currentExp.company : null,
    currentExp?.company_name,
    currentExp?.company?.name,
    currentExp?.organization,
    profileData?.current_company,
    profileData?.company,
    profileData?.company_name,
  );
  const location = pickString(
    profileData?.location,
    profileData?.region,
    profileData?.location_name,
  );
  const headline = pickString(profileData?.headline);
  const photo = pickString(
    profileData?.profile_picture_url,
    profileData?.profile_picture_url_large,
    profileData?.photo_url,
    profileData?.avatar_url,
  );

  // ── people columns: prefer to overwrite the flat current_* fields
  //    so the profile detail UI reflects the latest LinkedIn truth.
  //    LinkedIn mirror columns are always overwritten — they exist to
  //    record what LinkedIn last said.
  if (currentTitle && currentTitle !== (currentRow?.current_title ?? "")) {
    updates.current_title = currentTitle;
    updated.push("current_title");
  }
  if (currentCompany && currentCompany !== (currentRow?.current_company ?? "")) {
    updates.current_company = currentCompany;
    updated.push("current_company");
  }
  if (location && location !== (currentRow?.location_text ?? "")) {
    updates.location_text = location;
    updated.push("location_text");
  }

  if (currentTitle && currentTitle !== (currentRow?.linkedin_current_title ?? "")) {
    updates.linkedin_current_title = currentTitle;
    updated.push("linkedin_current_title");
  }
  if (currentCompany && currentCompany !== (currentRow?.linkedin_current_company ?? "")) {
    updates.linkedin_current_company = currentCompany;
    updated.push("linkedin_current_company");
  }
  if (location && location !== (currentRow?.linkedin_location ?? "")) {
    updates.linkedin_location = location;
    updated.push("linkedin_location");
  }
  if (headline && headline !== (currentRow?.linkedin_headline ?? "")) {
    updates.linkedin_headline = headline;
    updated.push("linkedin_headline");
  }
  if (photo) {
    if (photo !== (currentRow?.profile_picture_url ?? "")) {
      updates.profile_picture_url = photo;
      updated.push("profile_picture_url");
    }
    if (!currentRow?.avatar_url) {
      updates.avatar_url = photo;
      updated.push("avatar_url");
    }
  }

  // Always stamp sync metadata when we got a profile back, even if no
  // user-visible fields changed — recruiters need to see "last synced".
  updates.linkedin_profile_data = JSON.stringify(profileData);
  updates.linkedin_last_synced_at = new Date().toISOString();
  updates.linkedin_enriched_at = new Date().toISOString();
  updates.linkedin_enrichment_source = "unipile";
  updates.updated_at = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("people")
    .update(updates)
    .eq("id", personId);
  if (updErr) throw new Error(`people update failed: ${updErr.message}`);

  // ── candidate_work_history: replace from Unipile experience array.
  //    Delete-then-insert is the simplest correct strategy: LinkedIn is
  //    the source of truth, dates/titles can change subtly, and we
  //    don't want to leave stale rows behind when a job is renamed.
  let workHistoryRows = 0;
  if (expArray.length > 0) {
    const rows = expArray
      .map((exp: any) => flattenWorkExperience(exp, personId))
      .filter((r: any): r is NonNullable<typeof r> => r !== null);
    if (rows.length > 0) {
      await supabase.from("candidate_work_history").delete().eq("candidate_id", personId);
      const { error: insErr } = await supabase.from("candidate_work_history").insert(rows);
      if (!insErr) workHistoryRows = rows.length;
    }
  }

  return { fieldsUpdated: updated, workHistoryRows };
}

/* ───────────────────────────── helpers ────────────────────────────── */

function pickString(...vals: any[]): string {
  for (const v of vals) {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function asLinkedinSlug(url: string): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  if (m?.[1]) return m[1];
  // Already a bare slug?
  if (/^[a-zA-Z0-9_-]+$/.test(url)) return url;
  return null;
}

function buildFullName(person: PersonForLinkedinSearch): string | null {
  const full = (person.full_name || "").trim();
  if (full) return full;
  const joined = `${(person.first_name || "").trim()} ${(person.last_name || "").trim()}`.trim();
  return joined || null;
}

async function pickRecruiterAccount(
  supabase: any,
): Promise<{ unipile_account_id: string } | null> {
  const { data } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id, account_type")
    .or("account_type.eq.linkedin_recruiter,account_type.eq.linkedin_classic,account_type.eq.linkedin")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .order("account_type", { ascending: false })
    .limit(1);
  const acct = data?.[0];
  return acct?.unipile_account_id ? acct : null;
}

async function pickAnyLinkedinAccount(
  supabase: any,
): Promise<{ unipile_account_id: string } | null> {
  // Profile fetches work on any LinkedIn account type — recruiter,
  // classic, or generic — since /users/{slug} is universal.
  return pickRecruiterAccount(supabase);
}

async function runRecruiterSearch(
  supabase: any,
  unipileAccountId: string,
  fullName: string,
  currentCompany: string | null,
): Promise<SearchHit[]> {
  const keywords = currentCompany ? `${fullName} ${currentCompany}` : fullName;
  const body = await unipileFetch(supabase, unipileAccountId, "linkedin/search", {
    method: "POST",
    query: { limit: 10 },
    headers: {
      "Content-Type": "application/json",
      "X-UNIPILE-CLIENT": "sully-recruit",
    },
    body: JSON.stringify({ api: "recruiter", category: "people", keywords }),
  });
  const items: any[] = body?.data ?? body?.items ?? body?.results ?? [];
  return items.map((raw) => flattenHit(raw));
}

function flattenHit(raw: any): SearchHit {
  const profile = raw?.profile && typeof raw.profile === "object" ? raw.profile : raw;
  const work = (profile?.work_experience && profile.work_experience[0]) || {};
  const first = profile?.first_name || "";
  const last = profile?.last_name || "";
  const display = profile?.display_name || `${first} ${last}`.trim();
  return {
    name: display,
    profile_url: profile?.profile_url || profile?.linkedin_url || null,
    public_identifier: profile?.public_identifier || profile?.provider_id || null,
    current_company:
      profile?.current_company || work?.company?.name || work?.company || null,
  };
}

function scoreHit(
  hit: SearchHit,
  queryName: string,
  queryCompany: string | null,
): { name: number; company: number; total: number } {
  const name = nameSimilarity(queryName, hit.name);
  const company = queryCompany ? companyMatch(queryCompany, hit.current_company) : 0.5;
  const total = name * 0.7 + company * 0.3;
  return { name, company, total };
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const distance = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 0 : 1 - distance / maxLen;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyMatch(a: string, b: string | null): number {
  if (!b) return 0;
  const na = normalizeCompany(a);
  const nb = normalizeCompany(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const overlap = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : overlap / union;
}

function normalizeCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|holdings|group|technologies|tech)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Map one entry from Unipile's work_experience / experience array to a
 * candidate_work_history row. Returns null when the entry has no
 * company name (the schema requires it).
 */
function flattenWorkExperience(exp: any, candidateId: string): {
  candidate_id: string;
  company_name: string;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
  is_current: boolean;
} | null {
  const company = pickString(
    typeof exp?.company === "string" ? exp.company : null,
    exp?.company_name,
    exp?.company?.name,
    exp?.organization,
  );
  if (!company) return null;
  const title = pickString(exp?.title, exp?.position, exp?.role) || null;
  const description = pickString(exp?.description, exp?.summary) || null;
  return {
    candidate_id: candidateId,
    company_name: company,
    title,
    start_date: normalizeDate(exp?.start_date ?? exp?.start ?? exp?.starts_at ?? exp?.from),
    end_date: normalizeDate(exp?.end_date ?? exp?.end ?? exp?.ends_at ?? exp?.to),
    description,
    is_current: Boolean(
      exp?.is_current ?? exp?.current ?? (!exp?.end_date && !exp?.end && !exp?.ends_at && !exp?.to),
    ),
  };
}

/**
 * Coerce Unipile date fields (which arrive as ISO strings, year-only
 * strings, or {year, month} objects) into a YYYY-MM-DD date that
 * candidate_work_history.start_date / end_date can accept. Returns
 * null for anything unparseable.
 */
function normalizeDate(input: any): string | null {
  if (!input) return null;
  if (typeof input === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(input)) return input.slice(0, 10);
    if (/^\d{4}-\d{2}$/.test(input)) return `${input}-01`;
    if (/^\d{4}$/.test(input)) return `${input}-01-01`;
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof input === "object") {
    const year = Number(input.year);
    if (!year) return null;
    const month = Number(input.month) || 1;
    const day = Number(input.day) || 1;
    return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }
  return null;
}
