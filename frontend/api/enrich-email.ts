import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";
import {
  getApolloConfig,
  apolloMatchPerson,
} from "./lib/integrations/apollo.js";

/**
 * POST /api/enrich-email
 *
 * Business/work-email enrichment for a single person. Primary consumer is
 * the Chrome extension's CLIENT capture flow (where the person isn't a
 * `people` row yet), but it's a general-purpose lookup: hand it whatever
 * identifying fields you have and it returns the best contact info Apollo
 * can match.
 *
 * This is a thin wrapper over the shared Apollo People Match helper
 * (`api/lib/integrations/apollo.ts`). The DB-record-centric cascade in
 * `api/lib/enrichment-runner.ts` enriches existing `people` rows by id;
 * this endpoint takes raw form fields and never touches the database.
 *
 * Apollo auth: `APOLLO_API_KEY` from the `app_settings` table (read via
 * `getApolloConfig`), sent as the `x-api-key` header to
 * POST https://api.apollo.io/v1/people/match. We pass
 * `reveal_personal_emails: false` so the match stays work-email focused.
 *
 * Body:  { first_name?, last_name?, name?, company?, domain?, linkedin_url? }
 * Auth:  Supabase JWT (or service-role key) — see requireAuth.
 *
 * Returns 200 with:
 *   { work_email?, email?, phone?, title?, company?, source }   on a hit
 *   {}                                                          on a miss
 * Mirrors lookup-linkedin: a miss is a successful empty 200, not an error,
 * so the caller can treat "no match" and "found" with the same code path.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!(await requireAuth(req, res))) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const {
    first_name,
    last_name,
    name,
    company,
    domain,
    linkedin_url,
  } = (req.body || {}) as Record<string, string | undefined>;

  // Need at least one identifying signal to have any chance of a match.
  const hasName = Boolean(first_name || last_name || name);
  if (!hasName && !linkedin_url) return res.status(200).json({});

  // `company` may be either a plain company name or a domain. If it looks
  // like a domain (contains a dot, no spaces) treat it as one — Apollo
  // matches far better on domain than on name.
  let organization_name: string | undefined = company || undefined;
  let resolvedDomain: string | undefined = domain || undefined;
  if (!resolvedDomain && company && /^[^\s@]+\.[^\s@]+$/.test(company.trim())) {
    resolvedDomain = company.trim().toLowerCase();
    organization_name = undefined;
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey);
    const apolloConfig = await getApolloConfig(supabase);
    if (!apolloConfig) {
      // No provider configured — behave like a miss rather than 500 so the
      // capture UI degrades gracefully.
      console.warn("enrich-email: APOLLO_API_KEY not set in app_settings");
      return res.status(200).json({});
    }

    const match = await apolloMatchPerson(apolloConfig, {
      first_name,
      last_name,
      name: !first_name && !last_name ? name : undefined,
      organization_name,
      domain: resolvedDomain,
      linkedin_url,
      reveal_personal_emails: false,
    });

    if (!match) return res.status(200).json({});

    // Apollo's /people/match returns the work email in `email`. Surface it
    // as both `work_email` (explicit) and `email` (convenience) so callers
    // can use whichever they key on.
    const workEmail = match.email ?? undefined;

    const result: {
      work_email?: string;
      email?: string;
      phone?: string;
      title?: string;
      company?: string;
      source: string;
    } = { source: "apollo" };

    if (workEmail) {
      result.work_email = workEmail;
      result.email = workEmail;
    }
    if (match.phone) result.phone = match.phone;
    if (match.title) result.title = match.title;
    if (match.organization_name) result.company = match.organization_name;

    // If Apollo matched a person but exposed no usable contact info, return
    // an empty object so callers consistently treat "nothing found" the
    // same way regardless of whether the person existed in Apollo.
    if (!result.work_email && !result.phone && !result.title && !result.company) {
      return res.status(200).json({});
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("enrich-email failed:", err);
    return res.status(200).json({});
  }
}
