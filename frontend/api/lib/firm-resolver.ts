/**
 * Firm resolver — single source of truth for "which firm does this
 * domain / LinkedIn company page / company name belong to?"
 *
 * The `firms` table is the canonical umbrella entity; `firm_identifiers`
 * maps the many public faces (rbc.com, rbccm.com, the LinkedIn /company/rbc
 * page, the literal name "RBC Capital Markets") to one firm_id.
 *
 * Resolution order — exact-match first, fuzzy last:
 *   1. linkedin_company_id (exact)
 *   2. domain (exact, normalized to lowercase, no trailing dot)
 *   3. alias_name (exact, normalized to lowercase)
 *   4. firms.name (case-insensitive fuzzy via lower-name index)
 *
 * Returns the matched firm_id + the identifier type that matched, or
 * null when nothing matches. Callers that need to *create* a firm
 * row should do so explicitly — this function never writes.
 */

export type FirmIdentifierType = "linkedin_company_id" | "domain" | "alias_name" | "name";

export type FirmMatch = {
  firmId: string;
  matchedBy: FirmIdentifierType;
  confidence: number;
};

export type FirmIdentity = {
  domain?: string | null;
  linkedinCompanyId?: string | null;
  linkedinUrl?: string | null;
  name?: string | null;
};

const TRAILING_DOT = /\.+$/;

function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;
  // Strip protocol + path if a full URL was passed.
  const noProto = trimmed.replace(/^https?:\/\//, "").split("/")[0];
  return noProto.replace(TRAILING_DOT, "");
}

function extractLinkedinCompanyId(url: string | null | undefined): string | null {
  if (!url) return null;
  // Accept either a raw company slug or a full URL — the canonical
  // identifier_value is the LinkedIn company slug, since that's what
  // Unipile + the LinkedIn search returns for matches across spellings.
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (m) return m[1].toLowerCase();
  if (/^[\w-]+$/.test(url.trim())) return url.trim().toLowerCase();
  return null;
}

export async function resolveFirm(
  supabase: any,
  identity: FirmIdentity,
): Promise<FirmMatch | null> {
  const linkedinCompanyId =
    identity.linkedinCompanyId?.toLowerCase().trim() ||
    extractLinkedinCompanyId(identity.linkedinUrl);
  const domain = normalizeDomain(identity.domain);
  const name = identity.name?.trim().toLowerCase() || null;

  // 1. linkedin_company_id (exact)
  if (linkedinCompanyId) {
    const { data } = await supabase
      .from("firm_identifiers")
      .select("firm_id, confidence")
      .eq("identifier_type", "linkedin_company_id")
      .eq("identifier_value", linkedinCompanyId)
      .limit(1)
      .maybeSingle();
    if (data?.firm_id) {
      return { firmId: data.firm_id, matchedBy: "linkedin_company_id", confidence: data.confidence ?? 1 };
    }
  }

  // 2. domain (exact)
  if (domain) {
    const { data } = await supabase
      .from("firm_identifiers")
      .select("firm_id, confidence")
      .eq("identifier_type", "domain")
      .eq("identifier_value", domain)
      .limit(1)
      .maybeSingle();
    if (data?.firm_id) {
      return { firmId: data.firm_id, matchedBy: "domain", confidence: data.confidence ?? 1 };
    }
  }

  // 3. alias_name (exact, normalized lowercase)
  if (name) {
    const { data } = await supabase
      .from("firm_identifiers")
      .select("firm_id, confidence")
      .eq("identifier_type", "alias_name")
      .eq("identifier_value", name)
      .limit(1)
      .maybeSingle();
    if (data?.firm_id) {
      return { firmId: data.firm_id, matchedBy: "alias_name", confidence: data.confidence ?? 1 };
    }
  }

  // 4. firms.name (case-insensitive fuzzy). Last resort because the
  // primary_domain / linkedin_company_id approach is unambiguous; this
  // tier handles brand-new firms registered by name only.
  if (name) {
    const { data } = await supabase
      .from("firms")
      .select("id")
      .ilike("name", name)
      .limit(2);
    if (data?.length === 1) {
      return { firmId: data[0].id, matchedBy: "name", confidence: 0.7 };
    }
  }

  return null;
}

/**
 * Convenience helper for the common backfill case: resolve OR create
 * a firm by domain. Used by the cross-channel backfill engine when
 * an email lands from a domain we've never seen.
 */
export async function findOrCreateFirmByDomain(
  supabase: any,
  domain: string,
  fallbackName?: string,
): Promise<string | null> {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  const existing = await resolveFirm(supabase, { domain: normalized });
  if (existing) return existing.firmId;

  // Best-guess firm name from the domain root (rbccm.com → RBCCM).
  // The user will rename via the Companies UI; this just avoids a
  // null name that breaks display.
  const inferredName = fallbackName?.trim()
    || normalized.split(".")[0].toUpperCase();

  const { data: firm, error: firmErr } = await supabase
    .from("firms")
    .insert({ name: inferredName, primary_domain: normalized })
    .select("id")
    .single();
  if (firmErr || !firm?.id) return null;

  await supabase
    .from("firm_identifiers")
    .insert({
      firm_id: firm.id,
      identifier_type: "domain",
      identifier_value: normalized,
      confidence: 0.9, // domain-derived, not human-confirmed
    });

  return firm.id;
}
