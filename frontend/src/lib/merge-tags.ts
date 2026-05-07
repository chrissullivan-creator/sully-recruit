/**
 * Client-side mirror of frontend/src/trigger/lib/merge-tags.ts.
 *
 * Pure-JS implementation of the same merge-tag substitution that the
 * sequence-scheduler runs at send time, so the builder can show a
 * live preview of what each step's body will look like for a chosen
 * recipient without round-tripping to a Trigger.dev task.
 *
 * Keep this file in sync with the trigger version; the supported tag
 * set is the contract the recruiter sees in MERGE_TAGS in
 * SequenceStepCard.
 *
 * Supported tags: {{first_name}} {{last_name}} {{full_name}}
 *                 {{email}} {{title}} {{company}} {{company_name}}
 *                 {{job_name}} {{sender_name}}
 */

export type PersonRow = {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  email?: string | null;
  current_title?: string | null;
  current_company?: string | null;
  title?: string | null;          // contacts table uses `title`
  company_name?: string | null;   // contacts table uses `company_name`
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build a merge-vars dictionary from a candidate or contact row. */
export function mergeVarsFromPerson(
  person: PersonRow | null | undefined,
  extras: { jobName?: string; senderName?: string } = {},
): Record<string, string> {
  const p = person ?? {};
  const fullName =
    p.full_name?.trim() ||
    `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
  return {
    first_name: escapeHtml(p.first_name ?? ""),
    last_name: escapeHtml(p.last_name ?? ""),
    full_name: escapeHtml(fullName),
    email: escapeHtml(p.email ?? ""),
    title: escapeHtml(p.current_title ?? p.title ?? ""),
    company: escapeHtml(p.current_company ?? p.company_name ?? ""),
    company_name: escapeHtml(p.current_company ?? p.company_name ?? ""),
    job_name: escapeHtml(extras.jobName ?? ""),
    sender_name: escapeHtml(extras.senderName ?? ""),
  };
}

/**
 * Replace every {{key}} placeholder in `text` with the corresponding
 * value from `vars`. Unknown tags become empty string. first_name
 * falls back to "there" when blank to avoid awkward "Hi ,".
 */
export function applyMergeTags(text: string | null, vars: Record<string, string>): string {
  if (!text) return "";
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key] ?? "";
    if (key === "first_name" && !val) return "there";
    return val;
  });
}
