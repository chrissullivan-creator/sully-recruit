/**
 * Apollo.io REST client — thin wrapper over the two endpoints we
 * currently use:
 *
 *   POST /v1/people/match            → find LinkedIn URL + contact info
 *                                       from name + company / email
 *   POST /v1/organizations/enrich    → industry, size, description,
 *                                       logo, etc. from a domain
 *
 * Auth: APOLLO_API_KEY lives in app_settings (NOT in env or source).
 * Operator sets the row once; this module reads on demand with a 60s
 * in-process cache.
 *
 * No retry / circuit-breaker here — callers are Inngest functions with
 * their own retry semantics, and Apollo's rate limit reset is fast
 * enough that backing off via Inngest's per-event scheduling is fine.
 */

interface ApolloConfig {
  apiKey: string;
  baseUrl: string;
}

let _cached: { config: ApolloConfig; fetchedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

export async function getApolloConfig(supabase: any): Promise<ApolloConfig | null> {
  const now = Date.now();
  if (_cached && now - _cached.fetchedAt < CONFIG_TTL_MS) {
    return _cached.config;
  }
  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "APOLLO_API_KEY")
    .maybeSingle();
  const apiKey = row?.value;
  if (!apiKey) return null;
  const config = { apiKey, baseUrl: "https://api.apollo.io/v1" };
  _cached = { config, fetchedAt: now };
  return config;
}

export interface ApolloPerson {
  linkedin_url: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  headline: string | null;
  title: string | null;
  email: string | null;
  organization_name: string | null;
  organization_domain: string | null;
  photo_url: string | null;
  raw: any;
}

export interface PeopleMatchInput {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  organization_name?: string | null;
  domain?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
}

export async function apolloMatchPerson(
  config: ApolloConfig,
  input: PeopleMatchInput,
): Promise<ApolloPerson | null> {
  const body: Record<string, any> = {};
  if (input.first_name) body.first_name = input.first_name;
  if (input.last_name) body.last_name = input.last_name;
  if (input.name) body.name = input.name;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (input.domain) body.domain = input.domain;
  if (input.email) body.email = input.email;
  if (input.linkedin_url) body.linkedin_url = input.linkedin_url;

  const resp = await fetch(`${config.baseUrl}/people/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Apollo ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const person = data?.person;
  if (!person) return null;

  const org = person.organization || {};
  return {
    linkedin_url: person.linkedin_url ?? null,
    first_name: person.first_name ?? null,
    last_name: person.last_name ?? null,
    name: person.name ?? null,
    headline: person.headline ?? null,
    title: person.title ?? null,
    email: person.email ?? null,
    organization_name: org.name ?? null,
    organization_domain: org.primary_domain ?? null,
    photo_url: person.photo_url ?? null,
    raw: person,
  };
}

export interface ApolloOrganization {
  name: string | null;
  primary_domain: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  description: string | null;
  short_description: string | null;
  industry: string | null;
  estimated_num_employees: number | null;
  logo_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  raw: any;
}

export async function apolloEnrichOrganization(
  config: ApolloConfig,
  input: { domain?: string | null; organization_name?: string | null },
): Promise<ApolloOrganization | null> {
  const body: Record<string, any> = {};
  if (input.domain) body.domain = input.domain;
  if (input.organization_name) body.organization_name = input.organization_name;
  if (!body.domain && !body.organization_name) return null;

  const resp = await fetch(`${config.baseUrl}/organizations/enrich`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Apollo ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const org = data?.organization;
  if (!org) return null;

  return {
    name: org.name ?? null,
    primary_domain: org.primary_domain ?? null,
    website_url: org.website_url ?? null,
    linkedin_url: org.linkedin_url ?? null,
    description: org.short_description ?? org.description ?? null,
    short_description: org.short_description ?? null,
    industry: org.industry ?? null,
    estimated_num_employees: org.estimated_num_employees ?? null,
    logo_url: org.logo_url ?? null,
    city: org.city ?? null,
    state: org.state ?? null,
    country: org.country ?? null,
    raw: org,
  };
}
