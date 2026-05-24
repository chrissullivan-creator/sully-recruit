import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import {
  findLinkedinUrlForPerson,
  fetchUnipileProfile,
  applyLinkedinProfileToPerson,
} from "../lib/linkedin-finder.js";
import {
  getApolloConfig,
  apolloMatchPerson,
  type ApolloPerson,
} from "../lib/integrations/apollo.js";
import {
  getZeroBounceConfig,
  zerobounceValidate,
} from "../lib/integrations/zerobounce.js";
import {
  getPdlConfig,
  pdlEnrichPerson,
} from "../lib/integrations/pdl.js";
import {
  getBetterContactConfig,
  betterContactEnrich,
} from "../lib/integrations/bettercontact.js";
import {
  getFullEnrichConfig,
  fullEnrichContact,
} from "../lib/integrations/fullenrich.js";

/**
 * POST /api/people/enrich
 *
 * Enrich one or more people. Multi-provider cascade per field — the
 * recruiter picks which fields to spend credits on via `fields[]`, so
 * we never call APIs for slots they don't care about.
 *
 *   Body: {
 *     peopleIds: string[],                // up to 100
 *     fields:    Array<'work_email' | 'personal_email' | 'mobile' | 'linkedin_profile'>
 *   }
 *
 * Per-field cascade (Phase 2 — LeadMagic and Bytemine removed):
 *
 *   work_email:
 *     1. Apollo /people/match
 *        ├─ email_status ∈ {verified, likely_to_engage} → write directly
 *        └─ else                                        → ZeroBounce gate
 *     2. FullEnrich (waterfall) — accept only `valid`
 *     3. BetterContact (waterfall) — verifies upstream, accept as-is
 *
 *   personal_email:
 *     1. FullEnrich (personal)  — accept only `valid`
 *     2. PDL /person/enrich     → ZeroBounce gate
 *
 *   mobile:
 *     1. BetterContact (phone)  — prefer mobile, fall back to landline
 *     2. PDL /person/enrich     → mobile_phone (carrier-validated upstream)
 *
 *   linkedin_profile:
 *     1. If the person has no linkedin_url, search for one (Apollo
 *        /people/match → Unipile recruiter search).
 *     2. Fetch the full profile via Unipile v1 /users/{slug}.
 *     3. Update current_title / current_company / location_text +
 *        linkedin_* mirror columns, profile picture, candidate_work_history.
 *
 * Apollo is called at most once per person — its match response covers
 * work_email AND gives us apollo_person_id for future bulk re-enrichment.
 * We capture the ID even when the email isn't useable.
 *
 * Per-person writes (only fields that came back AND differ):
 *   apollo_person_id  → people.apollo_person_id (once, idempotent)
 *   work_email        → people.work_email + people.primary_email
 *                       (clears email_invalid when work_email changes)
 *   personal_email    → people.personal_email
 *   mobile            → people.mobile_phone (falls back to phone)
 *   linkedin_profile  → linkedin_url (if discovered) + current_title,
 *                       current_company, location_text, linkedin_*
 *                       mirror columns, profile_picture_url,
 *                       candidate_work_history rows
 *
 * Returns per-person results so a single bad row doesn't fail the
 * batch. `credits` totals each provider's spend so the caller can
 * show "spent N credits" feedback.
 */

type Field = "work_email" | "personal_email" | "mobile" | "linkedin_profile";
type ContactField = "work_email" | "personal_email" | "mobile";
type Source = "apollo" | "apollo_zb" | "fullenrich" | "bettercontact" | "pdl" | "pdl_zb" | "none";

interface EnrichResult {
  id: string;
  ok: boolean;
  error?: string;
  updated: string[];
  source?: Partial<Record<ContactField, Source>>;
  /** linkedin_profile-specific extras for caller telemetry. */
  linkedin?: {
    found_url?: string;
    url_source?: "apollo" | "unipile";
    profile_fetched: boolean;
    work_history_rows: number;
  };
}

const APOLLO_TRUSTED_EMAIL_STATUSES = new Set(["verified", "likely_to_engage"]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
  }

  const peopleIds: string[] = Array.isArray(req.body?.peopleIds) ? req.body.peopleIds : [];
  const fields: Field[] = Array.isArray(req.body?.fields) ? req.body.fields : ["work_email"];
  if (peopleIds.length === 0) return res.status(400).json({ error: "peopleIds[] required" });
  if (peopleIds.length > 100) return res.status(400).json({ error: "Max 100 per request" });
  if (fields.length === 0) return res.status(400).json({ error: "fields[] required" });

  // Load provider configs up-front. Each returns null if the key is
  // missing — the cascade gracefully skips that step. We DON'T 500 when
  // a provider is missing; the recruiter may have configured only some.
  const [apolloConfig, fullenrichConfig, bettercontactConfig, pdlConfig, zbConfig] =
    await Promise.all([
      getApolloConfig(supabase),
      getFullEnrichConfig(supabase),
      getBetterContactConfig(supabase),
      getPdlConfig(supabase),
      getZeroBounceConfig(supabase),
    ]);

  const wantsContactInfo = fields.some(
    (f) => f === "work_email" || f === "personal_email" || f === "mobile",
  );
  if (wantsContactInfo && !apolloConfig && !fullenrichConfig && !bettercontactConfig && !pdlConfig) {
    return res.status(500).json({
      error:
        "No enrichment provider configured. Set at least one of APOLLO_API_KEY / FULLENRICH_API_KEY / BETTERCONTACT_API_KEY / PDL_API_KEY in app_settings.",
    });
  }

  const { data: rows, error: peopleErr } = await supabase
    .from("people")
    .select("id, linkedin_url, work_email, personal_email, primary_email, mobile_phone, phone, current_title, current_company, location_text, email_invalid, first_name, last_name, full_name, avatar_url, profile_picture_url, linkedin_current_title, linkedin_current_company, linkedin_location, linkedin_headline, apollo_person_id")
    .in("id", peopleIds);
  if (peopleErr) return res.status(500).json({ error: `people lookup failed: ${peopleErr.message}` });

  const byId = new Map<string, any>((rows ?? []).map((r) => [r.id, r]));
  const results: EnrichResult[] = [];
  const credits = {
    apollo_calls: 0,
    fullenrich_calls: 0,
    bettercontact_calls: 0,
    pdl_calls: 0,
    zerobounce_checks: 0,
  };

  for (const id of peopleIds) {
    const row = byId.get(id);
    if (!row) {
      results.push({ id, ok: false, error: "person not found", updated: [] });
      continue;
    }

    const updates: Record<string, any> = {};
    const updated: string[] = [];
    const source: EnrichResult["source"] = {};
    let linkedinInfo: EnrichResult["linkedin"] | undefined;

    // ── linkedin_profile: URL discovery + Unipile profile fetch.
    //    Runs FIRST so a freshly-discovered URL feeds the contact
    //    cascades below as a more precise selector.
    if (fields.includes("linkedin_profile")) {
      linkedinInfo = { profile_fetched: false, work_history_rows: 0 };

      if (!row.linkedin_url) {
        try {
          const found = await findLinkedinUrlForPerson(supabase, {
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            full_name: row.full_name,
            current_company: row.current_company,
            primary_email: row.primary_email,
            work_email: row.work_email,
            personal_email: row.personal_email,
          });
          if (found?.url) {
            await supabase
              .from("people")
              .update({
                linkedin_url: found.url,
                linkedin_search_status: "found",
                linkedin_search_attempted_at: new Date().toISOString(),
              })
              .eq("id", id);
            row.linkedin_url = found.url;
            linkedinInfo.found_url = found.url;
            linkedinInfo.url_source = found.source;
            updated.push("linkedin_url");
          }
        } catch {
          // Discovery failures are non-fatal.
        }
      }

      if (row.linkedin_url) {
        const profile = await fetchUnipileProfile(supabase, row.linkedin_url);
        if (profile) {
          try {
            const applied = await applyLinkedinProfileToPerson(supabase, id, profile, row);
            linkedinInfo.profile_fetched = true;
            linkedinInfo.work_history_rows = applied.workHistoryRows;
            for (const f of applied.fieldsUpdated) {
              if (!updated.includes(f)) updated.push(f);
            }
          } catch (err: any) {
            results.push({
              id, ok: false,
              error: `profile apply failed: ${err.message}`,
              updated, source, linkedin: linkedinInfo,
            });
            continue;
          }
        }
      }
    }

    // ── Apollo: call once per person if any field needs it. Apollo
    //    gives us work_email + apollo_person_id + opportunistic title /
    //    company in a single $0.10 match call. Cache the result so we
    //    don't burn credits in the work_email branch below.
    let apolloMatch: ApolloPerson | null = null;
    const wantsApollo =
      apolloConfig &&
      (fields.includes("work_email") /* primary work-email source */);
    if (wantsApollo) {
      try {
        apolloMatch = await apolloMatchPerson(apolloConfig, {
          first_name: row.first_name,
          last_name: row.last_name,
          name: !row.first_name && !row.last_name ? row.full_name : null,
          organization_name: row.current_company,
          email: row.primary_email || row.work_email || row.personal_email,
          linkedin_url: row.linkedin_url,
        });
        credits.apollo_calls += 1;
        if (apolloMatch?.id && apolloMatch.id !== row.apollo_person_id) {
          updates.apollo_person_id = apolloMatch.id;
          updated.push("apollo_person_id");
        }
        // Opportunistic title / company backfill.
        if (apolloMatch?.title && !row.current_title) {
          updates.current_title = apolloMatch.title;
          updated.push("current_title");
        }
        if (apolloMatch?.organization_name && !row.current_company) {
          updates.current_company = apolloMatch.organization_name;
          updated.push("current_company");
        }
      } catch {
        // Apollo errors fall through to the next cascade step.
      }
    }

    // ── work_email ──────────────────────────────────────────────
    if (fields.includes("work_email")) {
      let workEmail: string | null = null;
      let workSource: Source = "none";

      // 1. Apollo (already fetched above)
      if (apolloMatch?.email) {
        const apolloEmail = apolloMatch.email.toLowerCase();
        const trusted =
          apolloMatch.email_status &&
          APOLLO_TRUSTED_EMAIL_STATUSES.has(apolloMatch.email_status.toLowerCase());
        if (trusted) {
          workEmail = apolloEmail;
          workSource = "apollo";
        } else if (zbConfig) {
          // Untrusted Apollo email → ZeroBounce gate.
          const check = await zerobounceValidate(zbConfig, apolloEmail);
          credits.zerobounce_checks += 1;
          if (check?.acceptable) {
            workEmail = apolloEmail;
            workSource = "apollo_zb";
          }
        }
      }

      // 2. FullEnrich (professional)
      if (!workEmail && fullenrichConfig) {
        const fe = await fullEnrichContact(
          fullenrichConfig,
          {
            firstname: row.first_name,
            lastname: row.last_name,
            company_name: row.current_company,
            linkedin_url: row.linkedin_url,
          },
          ["contact_email_professional"],
        );
        credits.fullenrich_calls += 1;
        if (fe?.professional_email && fe.professional_email_status === "valid") {
          workEmail = fe.professional_email.toLowerCase();
          workSource = "fullenrich";
        }
      }

      // 3. BetterContact (waterfall, verifies upstream)
      if (!workEmail && bettercontactConfig) {
        const bc = await betterContactEnrich(
          bettercontactConfig,
          {
            first_name: row.first_name,
            last_name: row.last_name,
            company: row.current_company,
            linkedin_url: row.linkedin_url,
          },
          { wantEmail: true, wantPhone: false },
        );
        credits.bettercontact_calls += 1;
        if (bc?.email) {
          workEmail = bc.email.toLowerCase();
          workSource = "bettercontact";
        }
      }

      if (workEmail && workEmail !== (row.work_email ?? "").toLowerCase()) {
        updates.work_email = workEmail;
        updates.primary_email = workEmail;
        updated.push("work_email", "primary_email");
        if (row.email_invalid) {
          updates.email_invalid = false;
          updates.email_invalid_at = null;
          updates.email_invalid_reason = null;
          updated.push("email_invalid");
        }
      }
      source.work_email = workSource;
    }

    // ── personal_email ──────────────────────────────────────────
    if (fields.includes("personal_email")) {
      let personal: string | null = null;
      let personalSource: Source = "none";

      // 1. FullEnrich (personal)
      if (fullenrichConfig) {
        const fe = await fullEnrichContact(
          fullenrichConfig,
          {
            firstname: row.first_name,
            lastname: row.last_name,
            company_name: row.current_company,
            linkedin_url: row.linkedin_url,
          },
          ["contact_email_personal"],
        );
        credits.fullenrich_calls += 1;
        if (fe?.personal_email && fe.personal_email_status === "valid") {
          personal = fe.personal_email.toLowerCase();
          personalSource = "fullenrich";
        }
      }

      // 2. PDL (gated through ZeroBounce — PDL emails are graph-derived)
      if (!personal && pdlConfig) {
        const pdlPerson = await pdlEnrichPerson(pdlConfig, {
          email: row.primary_email || row.work_email,
          linkedin_url: row.linkedin_url,
          first_name: row.first_name,
          last_name: row.last_name,
          company: row.current_company,
        });
        credits.pdl_calls += 1;
        const candidate = pdlPerson?.personal_email;
        if (candidate) {
          if (zbConfig) {
            const check = await zerobounceValidate(zbConfig, candidate);
            credits.zerobounce_checks += 1;
            if (check?.acceptable) {
              personal = candidate.toLowerCase();
              personalSource = "pdl_zb";
            }
          } else {
            // No verifier configured — write PDL's recommendation as-is.
            // Less safe than gating, but the operator may have chosen to
            // skip ZeroBounce for cost reasons.
            personal = candidate.toLowerCase();
            personalSource = "pdl";
          }
        }
      }

      if (personal && personal !== (row.personal_email ?? "").toLowerCase()) {
        updates.personal_email = personal;
        updated.push("personal_email");
      }
      source.personal_email = personalSource;
    }

    // ── mobile ──────────────────────────────────────────────────
    if (fields.includes("mobile")) {
      let mobile: string | null = null;
      let mobileSource: Source = "none";

      // 1. BetterContact (waterfall)
      if (bettercontactConfig) {
        const bc = await betterContactEnrich(
          bettercontactConfig,
          {
            first_name: row.first_name,
            last_name: row.last_name,
            company: row.current_company,
            linkedin_url: row.linkedin_url,
          },
          { wantEmail: false, wantPhone: true },
        );
        credits.bettercontact_calls += 1;
        if (bc?.phone) {
          mobile = bc.phone;
          mobileSource = "bettercontact";
        }
      }

      // 2. PDL
      if (!mobile && pdlConfig) {
        const pdlPerson = await pdlEnrichPerson(pdlConfig, {
          email: row.primary_email || row.work_email,
          linkedin_url: row.linkedin_url,
          first_name: row.first_name,
          last_name: row.last_name,
          company: row.current_company,
        });
        credits.pdl_calls += 1;
        if (pdlPerson?.mobile_phone) {
          mobile = pdlPerson.mobile_phone;
          mobileSource = "pdl";
        }
      }

      if (mobile) {
        // Prefer mobile_phone slot when empty; fall back to phone.
        if (!row.mobile_phone) {
          updates.mobile_phone = mobile;
          updated.push("mobile_phone");
        } else if (!row.phone) {
          updates.phone = mobile;
          updated.push("phone");
        }
      }
      source.mobile = mobileSource;
    }

    if (Object.keys(updates).length === 0) {
      // linkedin_profile may have already written via its helper; keep
      // the `updated` list (not empty in that case) so the toast counts
      // the row as changed.
      results.push({ id, ok: true, updated, source, linkedin: linkedinInfo });
      continue;
    }

    updates.updated_at = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("people").update(updates).eq("id", id);
    if (updErr) {
      results.push({
        id, ok: false, error: `update failed: ${updErr.message}`,
        updated, source, linkedin: linkedinInfo,
      });
      continue;
    }
    results.push({ id, ok: true, updated, source, linkedin: linkedinInfo });
  }

  return res.status(200).json({
    results,
    credits,
    counts: {
      total: peopleIds.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      changed: results.filter((r) => r.updated.length > 0).length,
    },
  });
}
