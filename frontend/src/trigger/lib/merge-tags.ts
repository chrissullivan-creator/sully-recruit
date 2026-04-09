/**
 * Merge-tag resolution and email body formatting.
 *
 * Supported tags: {{first_name}}, {{last_name}}, {{full_name}},
 * {{email}}, {{title}}, {{company}}, {{company_name}}
 */

/** HTML-escape a string to prevent XSS when embedded in email HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fetch entity fields and build a merge-tag dictionary.
 * Works for both candidates and contacts.
 */
export async function resolveMergeTags(
  supabase: any,
  entityId: string,
  entityType: "candidate" | "contact",
): Promise<Record<string, string>> {
  const table = entityType === "candidate" ? "candidates" : "contacts";
  const fields =
    entityType === "candidate"
      ? "first_name, last_name, full_name, email, title, company"
      : "first_name, last_name, full_name, email, title, company_name";

  const { data: entity } = await supabase
    .from(table)
    .select(fields)
    .eq("id", entityId)
    .single();

  if (!entity) return {};

  return {
    first_name: escapeHtml(entity.first_name ?? ""),
    last_name: escapeHtml(entity.last_name ?? ""),
    full_name: escapeHtml(
      entity.full_name ??
        `${entity.first_name ?? ""} ${entity.last_name ?? ""}`.trim(),
    ),
    email: escapeHtml(entity.email ?? ""),
    title: escapeHtml(entity.title ?? entity.title ?? ""),
    company: escapeHtml(entity.company ?? entity.company_name ?? ""),
    company_name: escapeHtml(entity.company ?? entity.company_name ?? ""),
  };
}

/**
 * Replace {{key}} placeholders with values from the merge-tag dictionary.
 * Unmatched tags are replaced with empty string.
 * first_name gets a fallback to "there" to avoid "Hi ," which looks robotic.
 */
export function applyMergeTags(
  text: string | null,
  vars: Record<string, string>,
): string {
  if (!text) return "";
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key] ?? "";
    // "Hi {{first_name}}" with null name → "Hi there" instead of "Hi ,"
    if (key === "first_name" && !val) return "there";
    return val;
  });
}

/**
 * Convert a plain-text body with newlines into HTML paragraphs.
 * If the body already contains HTML tags, return as-is.
 */
export function formatEmailBody(body: string): string {
  if (!body) return "";
  // Already HTML — leave it alone
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  // Convert double-newlines to paragraphs, single to <br>
  return (
    "<p>" +
    body
      .replace(/\r\n/g, "\n")
      .replace(/\n\n+/g, "</p><p>")
      .replace(/\n/g, "<br>") +
    "</p>"
  );
}

/**
 * Validate an email address for sending.
 * Rejects comma-separated, malformed, or obviously invalid addresses.
 */
export function validateEmail(email: string): { valid: boolean; reason?: string } {
  if (!email) return { valid: false, reason: "empty" };
  if (email.includes(",")) return { valid: false, reason: "comma_separated" };
  if (email.includes(" ")) return { valid: false, reason: "contains_spaces" };
  // Basic RFC-ish check: something@something.something, no trailing dots before @
  const pattern = /^[^\s@]+[^.]@[^\s@]+\.[^\s@]+$/;
  if (!pattern.test(email)) return { valid: false, reason: "malformed" };
  return { valid: true };
}
