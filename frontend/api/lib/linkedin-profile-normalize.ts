/**
 * Shared LinkedIn-profile field extraction.
 *
 * Mirrors the canonical normalization in api/lookup-linkedin.ts so the manual
 * "Add Person" path and the inbound auto-match enrichment agree on
 * title / company / location / headline / photo / public_identifier. Kept as a
 * standalone module (api/lib) so both the Vercel route and the Inngest
 * enrichment path can import it.
 */

export interface NormalizedLinkedInProfile {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  title?: string;
  company_name?: string;
  location?: string;
  headline?: string;
  photo?: string;
  linkedin_url?: string;
  public_identifier?: string;
}

/** First non-empty trimmed string among the args (ignores non-strings, so an
 *  object-shaped `location` falls through to the next candidate). */
export function pickString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return "";
}

/** First usable string from an array whose items may be plain strings or
 *  objects carrying the value under one of `keys` (e.g. Unipile's
 *  contact_info.emails / .phones). */
export function firstFromArray(arr: unknown, keys: string[]): string | null {
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object") {
      for (const k of keys) {
        const v = (item as Record<string, unknown>)[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

/**
 * Normalize a raw Unipile profile payload into form-compatible fields.
 * We do NOT parse the headline string for a job title — the headline is a
 * marketing tagline, not the position.
 */
export function normalizeLinkedInProfile(profileData: any): NormalizedLinkedInProfile {
  const expArray: any[] =
    (Array.isArray(profileData?.positions) && profileData.positions) ||
    (Array.isArray(profileData?.experience) && profileData.experience) ||
    (Array.isArray(profileData?.work_experience) && profileData.work_experience) ||
    [];
  const currentExp =
    expArray.find(
      (e: any) => e?.is_current || e?.current || (!e?.end_date && !e?.end && !e?.ends_at && !e?.to),
    ) ?? expArray[0] ?? null;

  const first_name = pickString(profileData?.first_name);
  const last_name = pickString(profileData?.last_name);
  const full_name =
    pickString(profileData?.full_name, profileData?.name, profileData?.display_name) ||
    [first_name, last_name].filter(Boolean).join(" ").trim();

  const title = pickString(
    currentExp?.title,
    currentExp?.position,
    currentExp?.role,
    profileData?.current_position,
    profileData?.current_title,
    profileData?.title,
  );
  const company_name = pickString(
    typeof currentExp?.company === "string" ? currentExp.company : null,
    currentExp?.company?.name,
    currentExp?.company_name,
    currentExp?.organization,
    profileData?.current_company,
    profileData?.company,
    profileData?.company_name,
  );
  const location = pickString(
    profileData?.location,
    profileData?.location?.name,
    profileData?.location?.display_name,
    profileData?.region,
    profileData?.location_name,
  );
  const headline = pickString(profileData?.headline);
  const photo = pickString(
    profileData?.profile_picture_url,
    profileData?.profile_picture_url_large,
    profileData?.picture_url,
    profileData?.image_url,
    profileData?.photo_url,
    profileData?.avatar_url,
  );
  const email = pickString(
    profileData?.email,
    firstFromArray(profileData?.contact_info?.emails, ["email", "address"]),
  );
  const phone = pickString(
    profileData?.phone,
    profileData?.phone_number,
    firstFromArray(profileData?.contact_info?.phones, ["number", "phone"]),
  );
  const public_identifier = pickString(profileData?.public_identifier);
  const linkedin_url =
    pickString(profileData?.public_profile_url) ||
    (public_identifier ? `https://www.linkedin.com/in/${public_identifier}` : "");

  const out: NormalizedLinkedInProfile = {};
  if (first_name) out.first_name = first_name;
  if (last_name) out.last_name = last_name;
  if (full_name) out.full_name = full_name;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  if (title) out.title = title;
  if (company_name) out.company_name = company_name;
  if (location) out.location = location;
  if (headline) out.headline = headline;
  if (photo) out.photo = photo;
  if (linkedin_url) out.linkedin_url = linkedin_url;
  if (public_identifier) out.public_identifier = public_identifier;
  return out;
}
