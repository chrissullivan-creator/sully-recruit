/**
 * Canonical job pipeline statuses — the single source of truth for the
 * frontend (and what the DB CHECK constraint enforces).
 *
 * Five statuses, in pipeline order:
 *   lead → hot → offer_made   (ACTIVE — still being worked)
 *   filled, closed_lost        (CLOSED — terminal)
 *
 * A job has exactly one status. "Active" and "closed" are derived groupings,
 * NOT separate flags — so a closed job (filled / closed_lost) is never also
 * active or hot. Use isClosedJobStatus / ACTIVE_JOB_STATUSES for filters
 * instead of hand-listing legacy values like 'closed_won' / 'open' / 'active'.
 */
export type JobStatus = "lead" | "hot" | "offer_made" | "filled" | "closed_lost";

export interface JobStatusMeta {
  value: JobStatus;
  label: string;
  group: "active" | "closed";
  /** Pill/badge background+text classes. */
  pillClass: string;
  /** Solid dot color (kanban header). */
  dotClass: string;
}

export const JOB_STATUSES: JobStatusMeta[] = [
  { value: "lead",        label: "Lead",        group: "active", pillClass: "bg-gray-100 text-gray-600",      dotClass: "bg-gray-400" },
  { value: "hot",         label: "Hot",         group: "active", pillClass: "bg-[#C9A84C]/10 text-[#C9A84C]", dotClass: "bg-[#C9A84C]" },
  { value: "offer_made",  label: "Offer Made",  group: "active", pillClass: "bg-[#2A5C42]/10 text-[#2A5C42]", dotClass: "bg-[#2A5C42]" },
  { value: "filled",      label: "Filled",      group: "closed", pillClass: "bg-[#1C3D2E] text-white",        dotClass: "bg-[#1C3D2E]" },
  { value: "closed_lost", label: "Closed Lost", group: "closed", pillClass: "bg-[#FEF2F2] text-[#DC2626]",    dotClass: "bg-[#DC2626]" },
];

export const JOB_STATUS_VALUES: JobStatus[] = JOB_STATUSES.map((s) => s.value);

export const ACTIVE_JOB_STATUSES: JobStatus[] = JOB_STATUSES.filter((s) => s.group === "active").map((s) => s.value);
export const CLOSED_JOB_STATUSES: JobStatus[] = JOB_STATUSES.filter((s) => s.group === "closed").map((s) => s.value);

/** PostgREST `not.in` list, e.g. `("filled","closed_lost")` — excludes closed jobs. */
export const CLOSED_JOB_STATUSES_SQL = `(${CLOSED_JOB_STATUSES.map((s) => `"${s}"`).join(",")})`;

export const isClosedJobStatus = (s?: string | null): boolean => !!s && (CLOSED_JOB_STATUSES as string[]).includes(s);
export const isActiveJobStatus = (s?: string | null): boolean => !!s && (ACTIVE_JOB_STATUSES as string[]).includes(s);

export function jobStatusMeta(s?: string | null): JobStatusMeta | undefined {
  return JOB_STATUSES.find((j) => j.value === s);
}

export function jobStatusLabel(s?: string | null): string {
  return jobStatusMeta(s)?.label ?? (s ?? "").replace(/_/g, " ");
}
