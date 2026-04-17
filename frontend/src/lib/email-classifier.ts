// Shared email classifier — used wherever ingestion needs to decide if an
// address is personal vs work. Keeping the rules in one place so they don't
// drift between bulk-add dialogs, resume parser, Clay enrichment, etc.

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "aol.com", "verizon.net", "comcast.net", "sbcglobal.net", "msn.com",
  "live.com", "me.com", "mac.com", "ymail.com", "mail.com", "protonmail.com",
  "gmx.com", "fastmail.com", "att.net", "cox.net", "charter.net",
  "optonline.net", "earthlink.net", "rocketmail.com", "duck.com",
  "pm.me", "proton.me",
]);

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

/**
 * Clean up raw email strings pulled from resumes/LinkedIn:
 * - Strip Word "HYPERLINK" artifacts (docx extraction leaks these)
 * - Strip mailto: prefixes, angle brackets, whitespace
 * - If multiple addresses are present (comma/semicolon/space separated),
 *   prefer the first personal-domain one so we don't stuff a corporate
 *   and personal address into the same field.
 * Returns null if nothing sensible can be extracted.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Pull out email-shaped tokens and ignore the rest (handles HYPERLINK and
  // other trailing garbage that would otherwise fail domain parsing).
  const matches = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,6}(?![A-Za-z0-9])/gi);
  if (!matches?.length) return null;
  const cleaned = matches.map((m) => m.trim().toLowerCase());
  const personal = cleaned.find((e) => isPersonalEmail(e));
  return personal ?? cleaned[0];
}

export function isPersonalEmail(email: string | null | undefined): boolean {
  const d = domainOf(email);
  if (!d) return false;
  if (PERSONAL_DOMAINS.has(d)) return true;
  // .edu addresses are almost always student/alumni personal addresses,
  // not corporate work addresses.
  if (d.endsWith(".edu")) return true;
  return false;
}

/**
 * Pick the right field for an incoming email. Returns either
 * { personal_email } or { work_email } so callers can spread into an upsert.
 */
export function classifyEmail(email: string | null | undefined): {
  personal_email?: string;
  work_email?: string;
} {
  if (!email) return {};
  return isPersonalEmail(email)
    ? { personal_email: email }
    : { work_email: email };
}
