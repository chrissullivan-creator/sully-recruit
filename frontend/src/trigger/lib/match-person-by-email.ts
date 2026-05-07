/**
 * One source of truth for matching an inbound email address back to a
 * person. Searches across all three address columns —
 *   people.email
 *   people.personal_email
 *   people.work_email
 * — so a candidate stored under their work address still matches when
 * they reply from gmail (and vice versa).
 *
 * Returns the first hit. People with multiple roles (`roles` array
 * containing both 'candidate' and 'client') resolve cleanly: the
 * matcher just returns the row, and callers that need to know how
 * to scope replies look at `roles` themselves.
 *
 * For backwards compat, `entityType` is set off the row's primary
 * `type` column (which our trigger keeps in sync with `roles`). Use
 * the returned `roles` array when you need the full picture.
 */
export interface PersonMatch {
  entityId: string;
  entityType: "candidate" | "client" | "contact";
  /** Convenient alias for column-name decisions in messages.* tables. */
  entityColumn: "candidate_id" | "contact_id";
  /** All roles this person carries — possibly both candidate + client. */
  roles: string[];
  /** Which column did we match on? Useful for logs. */
  matchedColumn: "email" | "personal_email" | "work_email";
}

export async function matchPersonByEmail(
  supabase: any,
  email: string | null | undefined,
): Promise<PersonMatch | null> {
  const normalized = (email || "").toLowerCase().trim();
  if (!normalized) return null;

  // Quote-escape any embedded single-quote so the .or() filter parses.
  // PostgREST's `or` mini-DSL doesn't support proper escaping, so we
  // refuse pathological inputs (which can't be valid email anyway).
  if (/[(),]/.test(normalized)) return null;

  const { data: peopleRows } = await supabase
    .from("people")
    .select("id, type, roles, email, personal_email, work_email")
    .or(
      `email.ilike.${normalized},personal_email.ilike.${normalized},work_email.ilike.${normalized}`,
    )
    .limit(1);

  if (peopleRows?.[0]) {
    const r = peopleRows[0];
    const matchedColumn: "email" | "personal_email" | "work_email" =
      (r.email || "").toLowerCase() === normalized
        ? "email"
        : (r.personal_email || "").toLowerCase() === normalized
          ? "personal_email"
          : "work_email";
    // Treat 'client' (unified people.type) as 'contact' for backwards
    // compat with code that still keys off the messages.contact_id
    // column; messages writers can flip on entityColumn.
    const entityType: PersonMatch["entityType"] =
      r.type === "client" ? "contact" : "candidate";
    return {
      entityId: r.id,
      entityType,
      entityColumn: entityType === "contact" ? "contact_id" : "candidate_id",
      roles: Array.isArray(r.roles) ? r.roles : [r.type].filter(Boolean),
      matchedColumn,
    };
  }

  // Legacy fallback — the contacts VIEW still sees rows where type='client'.
  // This keeps any caller that doesn't know about the unified people
  // table happy.
  const { data: contactRows } = await supabase
    .from("contacts")
    .select("id")
    .or(
      `email.ilike.${normalized},personal_email.ilike.${normalized},work_email.ilike.${normalized}`,
    )
    .limit(1);
  if (contactRows?.[0]) {
    return {
      entityId: contactRows[0].id,
      entityType: "contact",
      entityColumn: "contact_id",
      roles: ["client"],
      matchedColumn: "email", // can't know exactly, log generic
    };
  }

  return null;
}
