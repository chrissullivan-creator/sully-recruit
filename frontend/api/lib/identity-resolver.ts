/**
 * Identity resolver — single source of truth for (channel, identity) → person.
 *
 * The Communication Hub spine: every inbound message, email, call, or
 * calendar event resolves the counterparty through this function before
 * being stamped to `messages.candidate_id` / `messages.contact_id`.
 *
 * Resolution order (cheap first, exact-match before fuzzy):
 *   1. provider_id / unipile_id on `people` (3 columns)
 *   2. provider_id / unipile_id on `candidate_channels`  ← Pass-6 cache
 *   3. normalized LinkedIn slug on `people.normalized_linkedin_url`
 *   4. email address on `people` (multi-column, via matchPersonByEmail)
 *   5. phone on `people.phone` or `people.mobile_phone`
 *
 * Returns null on no match — caller flips `messages.needs_link = true`.
 * NEVER fabricates a person; the Hub's promise is "never silently drop".
 *
 * `link_method` is the resolver's audit trail. Whatever method resolves
 * the match is stamped on the message + conversation so a) we can grep
 * for low-confidence matches and b) the Tier-1 chat-resolver backfill
 * can flip rows from `needs_link=true` to `needs_link=false` with
 * provenance.
 */
import { normalizeLinkedIn } from "../../src/trigger/lib/resume-parsing.js";
import { matchPersonByEmail } from "../../src/trigger/lib/match-person-by-email.js";

export type ResolveChannel = "linkedin" | "email" | "sms" | "phone";

export type ResolveIdentity = {
  providerId?: string | null;
  unipileId?: string | null;
  publicIdentifier?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type LinkMethod =
  | "people_provider_id"
  | "people_unipile_id"
  | "channel_provider_id"
  | "channel_unipile_id"
  | "people_linkedin_slug"
  | "people_email"
  | "people_phone";

export type ResolvedPerson = {
  personId: string;
  personType: "candidate" | "contact";
  /** Which column to write on `messages` — preserves legacy candidate_id vs contact_id behavior. */
  entityColumn: "candidate_id" | "contact_id";
  linkMethod: LinkMethod;
};

const PHONE_DIGITS = /\D+/g;

function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(PHONE_DIGITS, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

function pickEntityColumn(personType: string | null): {
  personType: "candidate" | "contact";
  entityColumn: "candidate_id" | "contact_id";
} {
  if (personType === "client") {
    return { personType: "contact", entityColumn: "contact_id" };
  }
  return { personType: "candidate", entityColumn: "candidate_id" };
}

async function lookupPersonById(supabase: any, id: string) {
  const { data } = await supabase
    .from("people")
    .select("id, type")
    .eq("id", id)
    .maybeSingle();
  return data;
}

export async function resolvePerson(
  supabase: any,
  _channel: ResolveChannel,
  identity: ResolveIdentity,
): Promise<ResolvedPerson | null> {
  const providerId = identity.providerId?.trim() || null;
  const unipileId = identity.unipileId?.trim() || null;
  const publicIdentifier = identity.publicIdentifier?.trim() || null;
  const linkedinUrl = identity.linkedinUrl?.trim() || null;
  const email = identity.email?.trim().toLowerCase() || null;
  const phone = normalizePhone(identity.phone);

  // ── 1. provider_id / unipile_id on `people` (3 stamped columns) ──
  for (const id of [providerId, unipileId].filter(Boolean) as string[]) {
    const { data } = await supabase
      .from("people")
      .select("id, type")
      .or(
        `unipile_recruiter_id.eq.${id},unipile_classic_id.eq.${id},unipile_provider_id.eq.${id}`,
      )
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      const { personType, entityColumn } = pickEntityColumn(data.type);
      return {
        personId: data.id,
        personType,
        entityColumn,
        linkMethod: id === providerId ? "people_provider_id" : "people_unipile_id",
      };
    }
  }

  // ── 2. candidate_channels cache (Pass 6 — the Tier-1 backfill writes here) ──
  for (const id of [providerId, unipileId].filter(Boolean) as string[]) {
    const { data } = await supabase
      .from("candidate_channels")
      .select("candidate_id")
      .or(`provider_id.eq.${id},unipile_id.eq.${id}`)
      .limit(1)
      .maybeSingle();
    if (data?.candidate_id) {
      const person = await lookupPersonById(supabase, data.candidate_id);
      if (person?.id) {
        const { personType, entityColumn } = pickEntityColumn(person.type);
        return {
          personId: person.id,
          personType,
          entityColumn,
          linkMethod: id === providerId ? "channel_provider_id" : "channel_unipile_id",
        };
      }
    }
  }

  // ── 3. normalized LinkedIn slug on `people` ──
  //
  // Prefer the slug-shaped `publicIdentifier` from the Unipile payload
  // when present (it's exact). Fall back to extracting from a raw
  // linkedin_url when only the URL was supplied (lower-confidence
  // ilike match, last because of false positives on common slugs).
  const slug = publicIdentifier
    ? publicIdentifier.toLowerCase()
    : normalizeLinkedIn(linkedinUrl);
  if (slug) {
    // Exact match against the normalized slug column (the Pass-7
    // migration extracts slug from linkedin_url at insert time).
    const { data: exact } = await supabase
      .from("people")
      .select("id, type")
      .eq("normalized_linkedin_url", slug)
      .limit(1)
      .maybeSingle();
    if (exact?.id) {
      const { personType, entityColumn } = pickEntityColumn(exact.type);
      return {
        personId: exact.id,
        personType,
        entityColumn,
        linkMethod: "people_linkedin_slug",
      };
    }

    // Fallback: substring match for legacy rows where normalized_linkedin_url
    // wasn't populated. Single row only — collisions are user-visible.
    const { data: fuzzy } = await supabase
      .from("people")
      .select("id, type")
      .ilike("linkedin_url", `%/in/${slug}%`)
      .limit(2);
    if (fuzzy?.length === 1) {
      const { personType, entityColumn } = pickEntityColumn(fuzzy[0].type);
      return {
        personId: fuzzy[0].id,
        personType,
        entityColumn,
        linkMethod: "people_linkedin_slug",
      };
    }
  }

  // ── 4. email (multi-column via the existing helper) ──
  if (email) {
    const match = await matchPersonByEmail(supabase, email);
    if (match?.entityId) {
      return {
        personId: match.entityId,
        personType: match.entityType === "client" ? "contact" : "candidate",
        entityColumn: match.entityColumn,
        linkMethod: "people_email",
      };
    }
  }

  // ── 5. phone (last-10 digits match) ──
  if (phone) {
    const { data } = await supabase
      .from("people")
      .select("id, type")
      .or(`phone.ilike.%${phone},mobile_phone.ilike.%${phone}`)
      .limit(2);
    if (data?.length === 1) {
      const { personType, entityColumn } = pickEntityColumn(data[0].type);
      return {
        personId: data[0].id,
        personType,
        entityColumn,
        linkMethod: "people_phone",
      };
    }
  }

  return null;
}
