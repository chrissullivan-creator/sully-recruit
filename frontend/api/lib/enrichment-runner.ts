/**
 * Per-person enrichment runner. Single source of truth for the
 * cascade — called both by the synchronous /api/people/enrich
 * endpoint (small batches) and by the process-enrichment-job Inngest
 * function (background bulk).
 *
 * The cascade is identical to what enrich.ts's handler used to do
 * inline; this module just lifts it out so we can re-run it from
 * either runtime. See enrich.ts for the per-field cascade order and
 * the rationale behind each provider's place in line.
 */

import {
  findLinkedinUrlForPerson,
  fetchUnipileProfile,
  applyLinkedinProfileToPerson,
} from "./linkedin-finder.js";
import {
  getApolloConfig,
  apolloMatchPerson,
  type ApolloPerson,
} from "./integrations/apollo.js";
import {
  getZeroBounceConfig,
  zerobounceValidate,
} from "./integrations/zerobounce.js";
import {
  getPdlConfig,
  pdlEnrichPerson,
} from "./integrations/pdl.js";
import {
  getBetterContactConfig,
  betterContactEnrich,
} from "./integrations/bettercontact.js";
import {
  getFullEnrichConfig,
  fullEnrichContact,
} from "./integrations/fullenrich.js";

export type EnrichField = "work_email" | "personal_email" | "mobile" | "linkedin_profile";
type ContactField = "work_email" | "personal_email" | "mobile";
type Source = "apollo" | "apollo_zb" | "fullenrich" | "bettercontact" | "pdl" | "pdl_zb" | "none";

export interface EnrichResult {
  id: string;
  ok: boolean;
  error?: string;
  updated: string[];
  source?: Partial<Record<ContactField, Source>>;
  linkedin?: {
    found_url?: string;
    url_source?: "apollo" | "unipile";
    profile_fetched: boolean;
    work_history_rows: number;
  };
}

export interface EnrichCredits {
  apollo_calls: number;
  fullenrich_calls: number;
  bettercontact_calls: number;
  pdl_calls: number;
  zerobounce_checks: number;
}

const APOLLO_TRUSTED_EMAIL_STATUSES = new Set(["verified", "likely_to_engage"]);

export const PEOPLE_SELECT_COLS =
  "id, linkedin_url, work_email, personal_email, primary_email, mobile_phone, phone, " +
  "current_title, current_company, location_text, email_invalid, first_name, last_name, " +
  "full_name, avatar_url, profile_picture_url, linkedin_current_title, " +
  "linkedin_current_company, linkedin_location, linkedin_headline, apollo_person_id";

export interface RunOptions {
  /** If provided, mutated incrementally as each person finishes. Lets
   *  the Inngest job report progress without re-counting at the end. */
  onProgress?: (delta: { processed: number; changed: number; failed: number }) => Promise<void> | void;
}

/**
 * Run the cascade for a slice of people. Loads provider configs once
 * up front so a 100-person batch is one DB read for `app_settings`,
 * not 500.
 *
 * Throws only on configuration errors (no providers at all). Per-row
 * failures are captured in `results[].ok = false`.
 */
export async function runEnrichmentForPeople(
  supabase: any,
  peopleIds: string[],
  fields: EnrichField[],
  opts: RunOptions = {},
): Promise<{ results: EnrichResult[]; credits: EnrichCredits }> {
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
    throw new Error(
      "No enrichment provider configured. Set at least one of APOLLO_API_KEY / FULLENRICH_API_KEY / BETTERCONTACT_API_KEY / PDL_API_KEY in app_settings.",
    );
  }

  const { data: rows, error: peopleErr } = await supabase
    .from("people")
    .select(PEOPLE_SELECT_COLS)
    .in("id", peopleIds);
  if (peopleErr) throw new Error(`people lookup failed: ${peopleErr.message}`);

  const byId = new Map<string, any>((rows ?? []).map((r: any) => [r.id, r]));
  const results: EnrichResult[] = [];
  const credits: EnrichCredits = {
    apollo_calls: 0,
    fullenrich_calls: 0,
    bettercontact_calls: 0,
    pdl_calls: 0,
    zerobounce_checks: 0,
  };

  for (const id of peopleIds) {
    const before = results.length;
    const row = byId.get(id);
    if (!row) {
      results.push({ id, ok: false, error: "person not found", updated: [] });
      await emitProgress(opts, results, before);
      continue;
    }

    const updates: Record<string, any> = {};
    const updated: string[] = [];
    const source: EnrichResult["source"] = {};
    let linkedinInfo: EnrichResult["linkedin"] | undefined;

    // ── linkedin_profile ─────────────────────────────────────────
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
            await supabase.from("people").update({
              linkedin_url: found.url,
              linkedin_search_status: "found",
              linkedin_search_attempted_at: new Date().toISOString(),
            }).eq("id", id);
            row.linkedin_url = found.url;
            linkedinInfo.found_url = found.url;
            linkedinInfo.url_source = found.source;
            updated.push("linkedin_url");
          }
        } catch {
          // non-fatal
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
              id, ok: false, error: `profile apply failed: ${err.message}`,
              updated, source, linkedin: linkedinInfo,
            });
            await emitProgress(opts, results, before);
            continue;
          }
        }
      }
    }

    // ── Apollo (once per person) ─────────────────────────────────
    let apolloMatch: ApolloPerson | null = null;
    if (apolloConfig && fields.includes("work_email")) {
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
        if (apolloMatch?.title && !row.current_title) {
          updates.current_title = apolloMatch.title;
          updated.push("current_title");
        }
        if (apolloMatch?.organization_name && !row.current_company) {
          updates.current_company = apolloMatch.organization_name;
          updated.push("current_company");
        }
      } catch {
        // fall through
      }
    }

    // ── work_email ───────────────────────────────────────────────
    if (fields.includes("work_email")) {
      let workEmail: string | null = null;
      let workSource: Source = "none";

      if (apolloMatch?.email) {
        const apolloEmail = apolloMatch.email.toLowerCase();
        const trusted = apolloMatch.email_status &&
          APOLLO_TRUSTED_EMAIL_STATUSES.has(apolloMatch.email_status.toLowerCase());
        if (trusted) {
          workEmail = apolloEmail;
          workSource = "apollo";
        } else if (zbConfig) {
          const check = await zerobounceValidate(zbConfig, apolloEmail);
          credits.zerobounce_checks += 1;
          if (check?.acceptable) {
            workEmail = apolloEmail;
            workSource = "apollo_zb";
          }
        }
      }

      if (!workEmail && fullenrichConfig) {
        const fe = await fullEnrichContact(fullenrichConfig, {
          firstname: row.first_name,
          lastname: row.last_name,
          company_name: row.current_company,
          linkedin_url: row.linkedin_url,
        }, ["contact_email_professional"]);
        credits.fullenrich_calls += 1;
        if (fe?.professional_email && fe.professional_email_status === "valid") {
          workEmail = fe.professional_email.toLowerCase();
          workSource = "fullenrich";
        }
      }

      if (!workEmail && bettercontactConfig) {
        const bc = await betterContactEnrich(bettercontactConfig, {
          first_name: row.first_name,
          last_name: row.last_name,
          company: row.current_company,
          linkedin_url: row.linkedin_url,
        }, { wantEmail: true, wantPhone: false });
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

    // ── personal_email ───────────────────────────────────────────
    if (fields.includes("personal_email")) {
      let personal: string | null = null;
      let personalSource: Source = "none";

      if (fullenrichConfig) {
        const fe = await fullEnrichContact(fullenrichConfig, {
          firstname: row.first_name,
          lastname: row.last_name,
          company_name: row.current_company,
          linkedin_url: row.linkedin_url,
        }, ["contact_email_personal"]);
        credits.fullenrich_calls += 1;
        if (fe?.personal_email && fe.personal_email_status === "valid") {
          personal = fe.personal_email.toLowerCase();
          personalSource = "fullenrich";
        }
      }

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

    // ── mobile ───────────────────────────────────────────────────
    if (fields.includes("mobile")) {
      let mobile: string | null = null;
      let mobileSource: Source = "none";

      if (bettercontactConfig) {
        const bc = await betterContactEnrich(bettercontactConfig, {
          first_name: row.first_name,
          last_name: row.last_name,
          company: row.current_company,
          linkedin_url: row.linkedin_url,
        }, { wantEmail: false, wantPhone: true });
        credits.bettercontact_calls += 1;
        if (bc?.phone) {
          mobile = bc.phone;
          mobileSource = "bettercontact";
        }
      }

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
      results.push({ id, ok: true, updated, source, linkedin: linkedinInfo });
      await emitProgress(opts, results, before);
      continue;
    }

    updates.updated_at = new Date().toISOString();
    const { error: updErr } = await supabase.from("people").update(updates).eq("id", id);
    if (updErr) {
      results.push({
        id, ok: false, error: `update failed: ${updErr.message}`,
        updated, source, linkedin: linkedinInfo,
      });
    } else {
      results.push({ id, ok: true, updated, source, linkedin: linkedinInfo });
    }
    await emitProgress(opts, results, before);
  }

  return { results, credits };
}

async function emitProgress(
  opts: RunOptions,
  results: EnrichResult[],
  before: number,
): Promise<void> {
  if (!opts.onProgress || results.length === before) return;
  const newOnes = results.slice(before);
  await opts.onProgress({
    processed: newOnes.length,
    changed: newOnes.filter((r) => r.updated.length > 0).length,
    failed: newOnes.filter((r) => !r.ok).length,
  });
}
