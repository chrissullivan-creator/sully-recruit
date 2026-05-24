/**
 * People Data Labs (PDL) client — three endpoints we use today:
 *
 *   GET /v5/person/enrich   → person enrichment by name+company or email
 *                              or LinkedIn URL. Returns emails[],
 *                              mobile_phone, work_email, personal_emails[],
 *                              experience[], etc.
 *
 *   GET /v5/company/enrich  → company enrichment by domain or name.
 *                              Returns name, size, industry, founded,
 *                              location, summary, social_handles.
 *
 *   POST /v5/job/search     → search published job listings by company.
 *                              Used in Phase 3 (company_job_postings).
 *
 * Auth: PDL_API_KEY in app_settings (or env). Header: `X-Api-Key`.
 *
 * PDL emails are graph-derived, not validated — every email returned
 * SHOULD be re-verified via ZeroBounce before writing. PDL flags some
 * with `recommended: true` but we don't trust that signal alone.
 *
 * PDL pricing: per-match credits (~$0.10 per person, ~$0.05 per company).
 * Failing matches don't charge.
 */

interface PdlConfig {
  apiKey: string;
}

let _cached: { config: PdlConfig; fetchedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;
const BASE = "https://api.peopledatalabs.com/v5";

export async function getPdlConfig(supabase: any): Promise<PdlConfig | null> {
  const envKey = process.env.PDL_API_KEY;
  if (envKey) return { apiKey: envKey };

  const now = Date.now();
  if (_cached && now - _cached.fetchedAt < CONFIG_TTL_MS) return _cached.config;

  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "PDL_API_KEY")
    .maybeSingle();
  const apiKey = row?.value;
  if (!apiKey) return null;

  const config = { apiKey };
  _cached = { config, fetchedAt: now };
  return config;
}

/* ─────────────────────────── person enrich ─────────────────────────── */

export interface PdlPerson {
  /** Best work email PDL has for this person. */
  work_email: string | null;
  /** Highest-confidence personal email (PDL returns an array; we pick [0]). */
  personal_email: string | null;
  all_personal_emails: string[];
  mobile_phone: string | null;
  job_title: string | null;
  job_company_name: string | null;
  job_company_id: string | null;
  location_name: string | null;
  linkedin_url: string | null;
  experience: any[];
  raw: any;
}

export interface PdlPersonInput {
  email?: string | null;
  linkedin_url?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

export async function pdlEnrichPerson(
  config: PdlConfig,
  input: PdlPersonInput,
): Promise<PdlPerson | null> {
  const params = new URLSearchParams();
  if (input.email) params.set("email", input.email);
  if (input.linkedin_url) params.set("profile", input.linkedin_url);
  if (input.first_name) params.set("first_name", input.first_name);
  if (input.last_name) params.set("last_name", input.last_name);
  if (input.company) params.set("company", input.company);
  // PDL needs at least one selector — bail out if caller gave us nothing.
  if ([...params.keys()].length === 0) return null;
  params.set("min_likelihood", "6");

  try {
    const resp = await fetch(`${BASE}/person/enrich?${params.toString()}`, {
      method: "GET",
      headers: { "X-Api-Key": config.apiKey, Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    const data = body?.data;
    if (!data) return null;

    const personalEmails: string[] = Array.isArray(data?.personal_emails)
      ? data.personal_emails.filter((e: any) => typeof e === "string")
      : [];

    return {
      work_email: data?.work_email ?? data?.recommended_personal_email ?? null,
      personal_email: personalEmails[0] ?? null,
      all_personal_emails: personalEmails,
      mobile_phone: data?.mobile_phone ?? null,
      job_title: data?.job_title ?? null,
      job_company_name: data?.job_company_name ?? null,
      job_company_id: data?.job_company_id ?? null,
      location_name: data?.location_name ?? null,
      linkedin_url: data?.linkedin_url ?? null,
      experience: Array.isArray(data?.experience) ? data.experience : [],
      raw: data,
    };
  } catch {
    return null;
  }
}

/* ─────────────────────────── company enrich ────────────────────────── */

export interface PdlCompany {
  name: string | null;
  display_name: string | null;
  website: string | null;
  industry: string | null;
  size: string | null;
  founded: number | null;
  location_name: string | null;
  summary: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  raw: any;
}

export async function pdlEnrichCompany(
  config: PdlConfig,
  input: { domain?: string | null; name?: string | null },
): Promise<PdlCompany | null> {
  const params = new URLSearchParams();
  if (input.domain) params.set("website", input.domain);
  else if (input.name) params.set("name", input.name);
  else return null;

  try {
    const resp = await fetch(`${BASE}/company/enrich?${params.toString()}`, {
      method: "GET",
      headers: { "X-Api-Key": config.apiKey, Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data?.name && !data?.display_name) return null;

    return {
      name: data?.name ?? null,
      display_name: data?.display_name ?? null,
      website: data?.website ?? null,
      industry: data?.industry ?? null,
      size: data?.size ?? null,
      founded: typeof data?.founded === "number" ? data.founded : null,
      location_name: data?.location?.name ?? null,
      summary: data?.summary ?? null,
      linkedin_url: data?.linkedin_url ?? null,
      twitter_url: data?.twitter_url ?? null,
      facebook_url: data?.facebook_url ?? null,
      raw: data,
    };
  } catch {
    return null;
  }
}

/* ─────────────────────────── credit balance ────────────────────────── */

/**
 * PDL exposes credit info under /v5/account/me. The shape changes a
 * bit between plans, so this is intentionally lenient — picks the
 * first numeric value it finds for any of the candidate paths. Returns
 * null when nothing parses, which the alert cron treats as "unknown".
 */
export async function pdlGetCredits(config: PdlConfig): Promise<number | null> {
  try {
    const resp = await fetch(`${BASE}/account/me`, {
      headers: { "X-Api-Key": config.apiKey, Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const candidates = [
      data?.balance?.api_calls?.remaining,
      data?.usage_quotas?.api_calls?.remaining,
      data?.credits_remaining,
      data?.balance?.remaining,
    ];
    for (const v of candidates) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  } catch {
    return null;
  }
}

/* ─────────────────────────── job search ────────────────────────────── */

export interface PdlJobPosting {
  /** PDL's stable ID for this posting — use as the dedup key. */
  external_id: string;
  title: string | null;
  company_name: string | null;
  company_website: string | null;
  location_name: string | null;
  employment_type: string | null;
  seniority: string | null;
  description: string | null;
  posted_at: string | null;
  source_url: string | null;
  raw: any;
}

/**
 * Job-spec filters layered onto every PDL job/search call. The
 * operator writes a natural-language spec ("Senior eng leaders in
 * fintech NYC, $200k+, no interns") in Settings; an AI step
 * translates that to this JSON shape; we materialise it into PDL's
 * Elasticsearch DSL below. Any field can be omitted.
 */
export interface JobSpecFilters {
  title_includes?: string[];        // OR — any match counts
  title_excludes?: string[];        // NONE — exclude if any match
  seniorities?: string[];           // PDL values: junior | mid | senior | director | vp | cxo | ...
  locations?: string[];             // free-text location names (e.g. "new york", "san francisco")
  employment_types?: string[];      // full-time | part-time | contract | internship | ...
  industries?: string[];            // PDL industry strings
  min_salary?: number;              // minimum base — PDL has `salary` numeric field
  only_remote?: boolean;
}

function buildSpecClauses(filters: JobSpecFilters | null | undefined) {
  if (!filters) return { must: [], must_not: [] };
  const must: any[] = [];
  const must_not: any[] = [];

  if (filters.title_includes && filters.title_includes.length > 0) {
    must.push({
      bool: {
        should: filters.title_includes.map((t) => ({ match: { title: t } })),
        minimum_should_match: 1,
      },
    });
  }
  if (filters.title_excludes && filters.title_excludes.length > 0) {
    for (const t of filters.title_excludes) must_not.push({ match: { title: t } });
  }
  if (filters.seniorities && filters.seniorities.length > 0) {
    must.push({ terms: { "seniority.keyword": filters.seniorities.map((s) => s.toLowerCase()) } });
  }
  if (filters.locations && filters.locations.length > 0) {
    must.push({
      bool: {
        should: filters.locations.map((loc) => ({ match: { location_name: loc } })),
        minimum_should_match: 1,
      },
    });
  }
  if (filters.employment_types && filters.employment_types.length > 0) {
    must.push({ terms: { "employment_type.keyword": filters.employment_types.map((e) => e.toLowerCase()) } });
  }
  if (filters.industries && filters.industries.length > 0) {
    must.push({
      bool: {
        should: filters.industries.map((i) => ({ match: { industry: i } })),
        minimum_should_match: 1,
      },
    });
  }
  if (typeof filters.min_salary === "number" && filters.min_salary > 0) {
    must.push({ range: { salary: { gte: filters.min_salary } } });
  }
  if (filters.only_remote) {
    must.push({ term: { is_remote: true } });
  }
  return { must, must_not };
}

/**
 * Search PDL's job_listing dataset for a single company. Used by Phase 3
 * to populate company_job_postings.
 *
 * `since` is an ISO timestamp — postings older than this are filtered
 * server-side via PDL's Elasticsearch range query, so we only pull the
 * delta on each refresh.
 *
 * `filters` (optional) is the operator's saved job-spec — when set,
 * its clauses are merged into the same `bool` as the company match
 * + since-clause, so PDL only returns postings that match BOTH the
 * company AND the operator's lead criteria.
 */
export async function pdlSearchJobs(
  config: PdlConfig,
  input: {
    companyDomain?: string | null;
    companyName?: string | null;
    since?: string | null;
    size?: number;
    filters?: JobSpecFilters | null;
  },
): Promise<PdlJobPosting[]> {
  if (!input.companyDomain && !input.companyName) return [];

  const must: any[] = [];
  if (input.companyDomain) {
    must.push({ term: { "job_company_website.keyword": input.companyDomain } });
  } else if (input.companyName) {
    must.push({ match: { job_company_name: input.companyName } });
  }
  if (input.since) {
    must.push({ range: { posted_date: { gte: input.since } } });
  }

  const spec = buildSpecClauses(input.filters);
  must.push(...spec.must);

  try {
    const resp = await fetch(`${BASE}/job/search`, {
      method: "POST",
      headers: {
        "X-Api-Key": config.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: { bool: { must, must_not: spec.must_not } },
        size: input.size ?? 50,
      }),
    });
    if (!resp.ok) return [];
    const body = await resp.json();
    const items: any[] = Array.isArray(body?.data) ? body.data : [];
    return items
      .map((raw): PdlJobPosting | null => {
        const id = raw?.id ?? raw?.external_id;
        if (!id) return null;
        return {
          external_id: String(id),
          title: raw?.title ?? null,
          company_name: raw?.job_company_name ?? null,
          company_website: raw?.job_company_website ?? null,
          location_name: raw?.location_name ?? null,
          employment_type: raw?.employment_type ?? null,
          seniority: raw?.seniority ?? null,
          description: raw?.description ?? null,
          posted_at: raw?.posted_date ?? null,
          source_url: raw?.source_url ?? null,
          raw,
        };
      })
      .filter((p): p is PdlJobPosting => p !== null);
  } catch {
    return [];
  }
}
