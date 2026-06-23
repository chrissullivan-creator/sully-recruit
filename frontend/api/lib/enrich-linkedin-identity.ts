/**
 * Inbound auto-match enrichment.
 *
 * When the cheap DB lookups in `resolvePerson` miss for an inbound LinkedIn /
 * Recruiter-InMail sender, fetch their profile from Unipile and re-run the
 * resolver with the enriched identity (public_identifier / email / URL) BEFORE
 * we treat them as "not connected". This catches existing people we'd
 * otherwise show as unlinked just because we only had an opaque provider id.
 *
 * Profile fetch uses the Unipile **v1** surface (`/users/{id}?account_id=X`) —
 * the same proven route api/lookup-linkedin.ts uses. (Our v2 app key 403s on
 * profile lookups; the v2 surface is used for sends, not reads.)
 *
 * Guardrails (Unipile rate budget is tight — the backfill explicitly fights
 * 429s):
 *   - Webhook-only (one inbound at a time). NOT called from the bulk backfill.
 *   - Skip the network call if we already attempted a lookup for this chat in
 *     the last 24h (the unlinked-persist path stamps messages.link_attempted_at).
 *   - 9s timeout; any error / non-200 falls through to "unlinked" (returns null).
 *
 * NEVER creates a person — that's the user's one-click Add. On a successful
 * match it caches the provider id in candidate_channels so the next message
 * from this sender hard-matches cheaply (and the rate guard then short-circuits).
 */
import { resolvePerson, type ResolvedPerson } from "./identity-resolver.js";
import {
  normalizeLinkedInProfile,
  type NormalizedLinkedInProfile,
} from "./linkedin-profile-normalize.js";

const ENRICH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface EnrichArgs {
  providerId: string | null;
  integrationAccountId: string | null;
  /** Unipile chat / external_conversation_id — used for the rate-limit guard. */
  chatId?: string | null;
}

export interface EnrichResult {
  resolved: ResolvedPerson | null;
  profile: NormalizedLinkedInProfile | null;
}

export async function enrichAndRematch(
  supabase: any,
  args: EnrichArgs,
): Promise<EnrichResult> {
  const providerId = args.providerId?.trim() || null;
  if (!providerId) return { resolved: null, profile: null };

  // Rate-limit guard: if we already attempted a lookup for this chat recently
  // (linked or unlinked, both stamp link_attempted_at), don't hit Unipile again.
  if (args.chatId) {
    const sinceIso = new Date(Date.now() - ENRICH_LOOKBACK_MS).toISOString();
    const { data: recent } = await supabase
      .from("messages")
      .select("id")
      .eq("external_conversation_id", args.chatId)
      .not("link_attempted_at", "is", null)
      .gte("link_attempted_at", sinceIso)
      .limit(1);
    if (recent && recent.length > 0) return { resolved: null, profile: null };
  }

  const profile = await fetchLinkedInProfileByProviderId(
    supabase,
    providerId,
    args.integrationAccountId,
  );
  if (!profile) return { resolved: null, profile: null };

  const resolved = await resolvePerson(supabase, "linkedin", {
    providerId,
    unipileId: providerId,
    publicIdentifier: profile.public_identifier ?? null,
    linkedinUrl: profile.linkedin_url ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
  });

  if (resolved?.personId) {
    // Cache the provider id so the next message hard-matches (and the rate
    // guard short-circuits). candidate_channels.candidate_id stores the person
    // id regardless of type — that's how resolvePerson reads it back.
    await supabase
      .from("candidate_channels")
      .upsert(
        {
          candidate_id: resolved.personId,
          channel: "linkedin",
          provider_id: providerId,
        } as any,
        { onConflict: "candidate_id,channel" },
      );
  }

  return { resolved: resolved ?? null, profile };
}

/** Fetch + normalize a LinkedIn profile by Unipile provider id (v1 surface). */
async function fetchLinkedInProfileByProviderId(
  supabase: any,
  providerId: string,
  integrationAccountId: string | null,
): Promise<NormalizedLinkedInProfile | null> {
  const [{ data: baseRow }, { data: keyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  const v1Base =
    (baseRow?.value || "").replace(/\/+$/, "") || "https://api19.unipile.com:14926/api/v1";
  const apiKey = keyRow?.value;
  if (!apiKey) return null;

  // Prefer the account this thread arrived on; fall back to any active account.
  let acctId: string | undefined;
  if (integrationAccountId) {
    const { data: ia } = await supabase
      .from("integration_accounts")
      .select("unipile_account_id")
      .eq("id", integrationAccountId)
      .maybeSingle();
    acctId = ia?.unipile_account_id ?? undefined;
  }
  if (!acctId) {
    const { data: accts } = await supabase
      .from("integration_accounts")
      .select("unipile_account_id")
      .not("unipile_account_id", "is", null)
      .eq("is_active", true)
      .limit(1);
    acctId = accts?.[0]?.unipile_account_id ?? undefined;
  }
  if (!acctId) return null;

  try {
    const r = await fetch(
      `${v1Base}/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(acctId)}`,
      { headers: { "X-API-KEY": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(9000) },
    );
    if (!r.ok) return null;
    const raw: any = await r.json();
    return normalizeLinkedInProfile(raw);
  } catch {
    return null;
  }
}
