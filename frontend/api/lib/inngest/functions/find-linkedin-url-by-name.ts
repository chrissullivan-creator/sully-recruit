import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import { unipileFetch } from "../../../../src/trigger/lib/unipile-v2.js";

/**
 * Search Unipile recruiter for a LinkedIn profile matching a person and
 * write the URL back. Wired into the onboarding chain so a candidate or
 * client added without a LinkedIn URL still gets one:
 *
 *   resume parse / person insert
 *     → (no linkedin_url) people/find-linkedin-url.requested
 *     → search Unipile → write people.linkedin_url
 *     → BEFORE trigger sets unipile_resolve_status='pending'
 *     → resolve-unipile-ids cron resolves provider_id
 *     → fetch-entity-history pulls full LinkedIn message history
 *
 * Match policy (conservative — false positives are worse than misses,
 * since a wrong linkedin_url poisons every downstream message + send):
 *   - Required: full_name OR (first_name AND last_name)
 *   - Compare normalized name similarity (Levenshtein ratio) on the
 *     candidate's full name against each result. Best must be >= 0.92.
 *   - Tie-break: if a second result is >= 0.85, mark 'ambiguous' and
 *     skip the write — operator can resolve manually.
 *   - Company signal: if person has current_company, prefer results
 *     whose current_company contains or is contained by it (case-
 *     insensitive substring after stripping common suffixes).
 *
 * Concurrency keyed on person_id prevents duplicate sweeps for the same
 * person from racing each other.
 */
interface FindUrlPayload {
  person_id: string;
}

interface SearchHit {
  name: string;
  profile_url: string | null;
  public_identifier: string | null;
  current_company: string | null;
  headline: string | null;
  raw: any;
}

export const findLinkedinUrlByName = inngest.createFunction(
  {
    id: "find-linkedin-url-by-name",
    name: "Find LinkedIn URL by name (Inngest)",
    retries: 1,
    concurrency: [{ key: "event.data.person_id", limit: 1 }],
  },
  { event: "people/find-linkedin-url.requested" },
  async ({ event, logger }) => {
    const { person_id } = event.data as FindUrlPayload;
    const supabase = getSupabaseAdmin();

    const { data: person, error: personErr } = await supabase
      .from("people")
      .select(
        "id, first_name, last_name, full_name, current_company, primary_email, work_email, personal_email, linkedin_url, linkedin_search_status, is_stub",
      )
      .eq("id", person_id)
      .maybeSingle();
    if (personErr || !person) {
      logger.warn("find-linkedin-url: person not found", { person_id, error: personErr?.message });
      return { skipped: true, reason: "person_not_found" };
    }

    if (person.is_stub) {
      return { skipped: true, reason: "is_stub" };
    }
    if (person.linkedin_url && person.linkedin_url.trim()) {
      await stampAttempted(supabase, person_id, "found");
      return { skipped: true, reason: "already_has_url" };
    }

    const fullName = buildFullName(person);
    if (!fullName) {
      await stampAttempted(supabase, person_id, "insufficient_data");
      return { skipped: true, reason: "no_name" };
    }

    const account = await pickRecruiterAccount(supabase);
    if (!account) {
      logger.warn("find-linkedin-url: no active LinkedIn recruiter account");
      // Don't stamp — leave row retryable so a future sweep with a
      // working account can find it.
      return { skipped: true, reason: "no_unipile_account" };
    }

    let hits: SearchHit[];
    try {
      hits = await runRecruiterSearch(supabase, account.unipile_account_id, fullName, person.current_company);
    } catch (err: any) {
      logger.warn("find-linkedin-url: search threw", { person_id, error: err?.message });
      await stampAttempted(supabase, person_id, "failed");
      return { error: err?.message ?? "search_failed" };
    }

    if (hits.length === 0) {
      await stampAttempted(supabase, person_id, "not_found");
      return { matched: false, reason: "no_results" };
    }

    const scored = hits
      .map((hit) => ({
        hit,
        score: scoreHit(hit, fullName, person.current_company),
      }))
      .sort((a, b) => b.score.total - a.score.total);

    const best = scored[0];
    const second = scored[1];

    const PRIMARY_THRESHOLD = 0.92;
    const AMBIGUITY_THRESHOLD = 0.85;

    if (best.score.total < PRIMARY_THRESHOLD) {
      await stampAttempted(supabase, person_id, "not_found");
      return {
        matched: false,
        reason: "below_threshold",
        best_score: best.score.total,
        best_name: best.hit.name,
      };
    }

    if (second && second.score.total >= AMBIGUITY_THRESHOLD) {
      await stampAttempted(supabase, person_id, "ambiguous");
      return {
        matched: false,
        reason: "ambiguous",
        best: { name: best.hit.name, score: best.score.total },
        second: { name: second.hit.name, score: second.score.total },
      };
    }

    const winnerUrl =
      best.hit.profile_url
      || (best.hit.public_identifier
          ? `https://www.linkedin.com/in/${best.hit.public_identifier}`
          : null);
    if (!winnerUrl) {
      await stampAttempted(supabase, person_id, "not_found");
      return { matched: false, reason: "winner_has_no_url" };
    }

    // Writing linkedin_url here fires the BEFORE trigger
    // set_unipile_pending_on_linkedin_url and the AFTER trigger
    // notify_person_created (via the linkedin_url-just-added branch),
    // which chains into resolve + history fetch automatically.
    const { error: updateErr } = await supabase
      .from("people")
      .update({
        linkedin_url: winnerUrl,
        linkedin_search_status: "found",
        linkedin_search_attempted_at: new Date().toISOString(),
      } as any)
      .eq("id", person_id);
    if (updateErr) {
      logger.error("find-linkedin-url: update failed", { person_id, error: updateErr.message });
      return { error: updateErr.message };
    }

    return {
      matched: true,
      person_id,
      linkedin_url: winnerUrl,
      score: best.score.total,
      name_sim: best.score.name,
      company_match: best.score.company,
    };
  },
);

async function stampAttempted(
  supabase: any,
  person_id: string,
  status: string,
): Promise<void> {
  await supabase
    .from("people")
    .update({
      linkedin_search_status: status,
      linkedin_search_attempted_at: new Date().toISOString(),
    } as any)
    .eq("id", person_id);
}

function buildFullName(person: any): string | null {
  const full = (person.full_name || "").trim();
  if (full) return full;
  const first = (person.first_name || "").trim();
  const last = (person.last_name || "").trim();
  const joined = `${first} ${last}`.trim();
  return joined || null;
}

async function pickRecruiterAccount(
  supabase: any,
): Promise<{ id: string; unipile_account_id: string; account_type: string } | null> {
  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id, unipile_account_id, account_type")
    .or("account_type.eq.linkedin_recruiter,account_type.eq.linkedin_classic,account_type.eq.linkedin")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .order("account_type", { ascending: false }) // recruiter > classic > linkedin
    .limit(1);
  const acct = accounts?.[0];
  return acct?.unipile_account_id ? acct : null;
}

async function runRecruiterSearch(
  supabase: any,
  unipileAccountId: string,
  fullName: string,
  currentCompany: string | null,
): Promise<SearchHit[]> {
  // POST /api/v2/{account_id}/linkedin/recruiter/search/people
  // Keywords is the broadest filter and accepts free text. Append
  // company as a hint to bias ranking when we have it.
  const keywords = currentCompany
    ? `${fullName} ${currentCompany}`
    : fullName;

  const body = await unipileFetch(
    supabase,
    unipileAccountId,
    "linkedin/recruiter/search/people?limit=10",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-UNIPILE-CLIENT": "sully-recruit",
      },
      body: JSON.stringify({ keywords }),
    },
  );

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
    headline: profile?.headline || null,
    raw,
  };
}

function scoreHit(
  hit: SearchHit,
  queryName: string,
  queryCompany: string | null,
): { name: number; company: number; total: number } {
  const name = nameSimilarity(queryName, hit.name);
  const company = queryCompany ? companyMatch(queryCompany, hit.current_company) : 0.5;
  // 70/30 weighting — name carries more signal than company (people
  // change jobs; rarely change names). 0.5 neutral when we have no
  // company on either side so a strong name match alone can still win.
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
    .replace(/[̀-ͯ]/g, "") // strip diacritics
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
  // Token overlap fallback — common for "Big Co Inc" vs "Big Co".
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
