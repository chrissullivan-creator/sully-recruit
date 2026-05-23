import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/admin/scan-collisions
 *
 * Detects candidate records that look like more than one real person was
 * merged into one row ("collisions"). The inverse of /api/dedup/scan,
 * which finds two rows that should become one.
 *
 * Signals, in decreasing confidence:
 *   - CRITICAL: 2+ distinct normalized names across the candidate's
 *     resumes AND (2+ distinct emails OR 2+ distinct LinkedIn slugs).
 *     This is essentially never a name-format artifact - it's two
 *     different humans whose CVs both landed on one candidate row.
 *   - HIGH: 2+ distinct normalized names across resumes only.
 *     Could be a real collision or just name format variants
 *     (e.g. "Daniel A. Ojeda" vs "Daniel Ojeda"); the side-by-side
 *     UI lets a human decide.
 *   - MEDIUM: profile current_company doesn't match any of the
 *     candidate's parsed resume companies AND the candidate's
 *     linkedin_url has no overlap with any resume's parsed
 *     linkedin_url. Captures the Christopher Smith case (profile
 *     Citi VP, resumes all JPMorgan, internal LinkedIn member ID).
 *   - LOW: just a recruiter-style LinkedIn member-ID slug with
 *     no other signals.
 *
 * Body: { limit?: number (max suspects to return, default 200, cap 500) }
 * Auth: Supabase user JWT (admin email check) or service role.
 */

type ResumeIdentity = {
  resume_id: string;
  file_name: string | null;
  parsed_first_name: string | null;
  parsed_last_name: string | null;
  parsed_email: string | null;
  parsed_linkedin_url: string | null;
  parsed_current_company: string | null;
  parsed_current_title: string | null;
  created_at: string;
};

type Suspect = {
  candidate_id: string;
  full_name: string;
  current_title: string | null;
  current_company: string | null;
  linkedin_url: string | null;
  resume_count: number;
  resume_identities: ResumeIdentity[];
  severity: "critical" | "high" | "medium" | "low";
  reasons: string[];
};

const SEVERITY_RANK: Record<Suspect["severity"], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|esq)\.?\b/g, "")
    .replace(/\b[a-z]\.\s?/g, "") // strip single-letter+period (middle initial)
    .replace(/[^a-z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompany(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|llp|ltd|co|corp|corporation|company|group|& co|& company|holdings|capital|partners)\.?\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinkedinSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/\/$/, "") : null;
}

function isBogusLinkedinSlug(slug: string | null): boolean {
  if (!slug) return false;
  // Real vanity URLs: short, or include a hyphen, or include a period.
  // Recruiter member-IDs: 25+ chars, no hyphens, no period, all alphanumeric.
  return slug.length >= 25 && !slug.includes("-") && !slug.includes(".") && /^[a-z0-9]+$/.test(slug);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireAuth(req, res))) return;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const limit = Math.min(Math.max(Number(req.body?.limit) || 200, 1), 500);

  try {
    // 1. Pull every resume row with its parsed identity. We'll bucket by
    //    candidate_id in JS so the heavy lifting happens in one trip.
    const PAGE = 1000;
    type Row = {
      id: string;
      candidate_id: string | null;
      file_name: string | null;
      parsed_json: any;
      created_at: string;
    };
    const allResumes: Row[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("resumes")
        .select("id, candidate_id, file_name, parsed_json, created_at")
        .not("candidate_id", "is", null)
        .not("parsed_json", "is", null)
        .range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: `resumes scan: ${error.message}` });
      if (!data || data.length === 0) break;
      allResumes.push(...(data as Row[]));
      if (data.length < PAGE) break;
    }

    // 2. Group resume identities by candidate.
    const byCandidate = new Map<string, ResumeIdentity[]>();
    for (const r of allResumes) {
      if (!r.candidate_id) continue;
      const pj = (r.parsed_json ?? {}) as Record<string, any>;
      const identity: ResumeIdentity = {
        resume_id: r.id,
        file_name: r.file_name,
        parsed_first_name: pj.first_name ? String(pj.first_name) : null,
        parsed_last_name: pj.last_name ? String(pj.last_name) : null,
        parsed_email: pj.email ? String(pj.email) : null,
        parsed_linkedin_url: pj.linkedin_url ? String(pj.linkedin_url) : null,
        parsed_current_company: pj.current_company ? String(pj.current_company) : null,
        parsed_current_title: pj.current_title ? String(pj.current_title) : null,
        created_at: r.created_at,
      };
      const arr = byCandidate.get(r.candidate_id) ?? [];
      arr.push(identity);
      byCandidate.set(r.candidate_id, arr);
    }

    // 3. Pull profile data for every candidate that has at least one resume,
    //    plus every candidate flagged as having a bogus linkedin slug.
    //    Batch via .in() in chunks of 200 ids.
    const candidateIds = Array.from(byCandidate.keys());
    type ProfileRow = {
      id: string;
      first_name: string | null;
      last_name: string | null;
      current_title: string | null;
      current_company: string | null;
      linkedin_url: string | null;
    };
    const profiles = new Map<string, ProfileRow>();
    const CHUNK = 200;
    for (let i = 0; i < candidateIds.length; i += CHUNK) {
      const slice = candidateIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("people")
        .select("id, first_name, last_name, current_title, current_company, linkedin_url")
        .in("id", slice)
        .eq("type", "candidate")
        .is("deleted_at", null);
      if (error) return res.status(500).json({ error: `people scan: ${error.message}` });
      for (const row of data ?? []) profiles.set(row.id, row as ProfileRow);
    }

    // 4. Compute signals per candidate.
    const suspects: Suspect[] = [];

    for (const [cid, identities] of byCandidate) {
      const profile = profiles.get(cid);
      if (!profile) continue; // candidate was deleted or wrong type

      const reasons: string[] = [];

      // Multi-distinct-name signal
      const normalizedNames = new Set(
        identities
          .map((i) => normalizeName(`${i.parsed_first_name ?? ""} ${i.parsed_last_name ?? ""}`))
          .filter((n) => n.length > 0),
      );
      const multiName = normalizedNames.size > 1;

      // Multi-distinct-email signal
      const emails = new Set(
        identities
          .map((i) => (i.parsed_email ?? "").toLowerCase().trim())
          .filter((e) => e.length > 0),
      );
      const multiEmail = emails.size > 1;

      // Multi-distinct-linkedin signal
      const linkedinSlugs = new Set(
        identities
          .map((i) => extractLinkedinSlug(i.parsed_linkedin_url))
          .filter((s): s is string => !!s),
      );
      const multiLinkedin = linkedinSlugs.size > 1;

      // Profile-vs-resume company mismatch
      const profileCompanyNorm = normalizeCompany(profile.current_company ?? "");
      const resumeCompanyNorms = identities
        .map((i) => normalizeCompany(i.parsed_current_company ?? ""))
        .filter((c) => c.length > 0);
      const companyMismatch =
        profileCompanyNorm.length > 0 &&
        resumeCompanyNorms.length > 0 &&
        !resumeCompanyNorms.some(
          (rc) => rc === profileCompanyNorm || rc.includes(profileCompanyNorm) || profileCompanyNorm.includes(rc),
        );

      // LinkedIn URL is a recruiter-internal slug (not a vanity URL)
      const profileSlug = extractLinkedinSlug(profile.linkedin_url);
      const bogusLinkedin = isBogusLinkedinSlug(profileSlug);

      // Profile LinkedIn doesn't overlap any resume LinkedIn
      const linkedinDisjoint =
        profileSlug !== null &&
        linkedinSlugs.size > 0 &&
        !linkedinSlugs.has(profileSlug);

      if (multiName) reasons.push("multi_distinct_names_on_resumes");
      if (multiEmail) reasons.push("multi_distinct_emails_on_resumes");
      if (multiLinkedin) reasons.push("multi_distinct_linkedin_on_resumes");
      if (companyMismatch) reasons.push("profile_company_differs_from_resumes");
      if (linkedinDisjoint) reasons.push("profile_linkedin_not_in_resumes");
      if (bogusLinkedin) reasons.push("bogus_linkedin_slug");

      if (reasons.length === 0) continue;

      let severity: Suspect["severity"];
      if (multiName && (multiEmail || multiLinkedin)) severity = "critical";
      else if (multiName) severity = "high";
      else if (companyMismatch || linkedinDisjoint) severity = "medium";
      else severity = "low";

      suspects.push({
        candidate_id: cid,
        full_name: `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim(),
        current_title: profile.current_title,
        current_company: profile.current_company,
        linkedin_url: profile.linkedin_url,
        resume_count: identities.length,
        resume_identities: identities,
        severity,
        reasons,
      });
    }

    suspects.sort((a, b) => {
      const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      return s !== 0 ? s : b.resume_count - a.resume_count;
    });

    return res.status(200).json({
      scanned_at: new Date().toISOString(),
      total_resume_rows_scanned: allResumes.length,
      total_candidates_with_resumes: byCandidate.size,
      total_suspects: suspects.length,
      severity_breakdown: {
        critical: suspects.filter((s) => s.severity === "critical").length,
        high: suspects.filter((s) => s.severity === "high").length,
        medium: suspects.filter((s) => s.severity === "medium").length,
        low: suspects.filter((s) => s.severity === "low").length,
      },
      suspects: suspects.slice(0, limit),
    });
  } catch (err: any) {
    console.error("admin/scan-collisions error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
