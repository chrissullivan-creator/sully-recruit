import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { unipileFetch } from "../../../../src/server-lib/unipile-v2.js";
import { normalizeLinkedIn } from "../../../../src/server-lib/resume-parsing.js";

/**
 * On-demand single-person Unipile resolver.
 *
 * The `person-created` DB webhook fires this the moment a person with a
 * LinkedIn URL is added (or has a URL added later), so their provider_id is
 * cached "going forward" — long before they're ever enrolled in a sequence.
 * That keeps the sequence engine's connection step from doing the FIRST cold
 * provider-id lookup itself under a batch burst (which tripped Unipile's
 * 1-request/second cap → 429 → dropped LinkedIn steps).
 *
 * Why an Inngest function and not the old fire-and-forget POST to
 * `/api/resolve-person-now`:
 *   - **Throttle.** `concurrency: [{ limit: 1 }]` serializes lookups, so a
 *     bulk import of N people resolves one-at-a-time instead of firing N
 *     concurrent calls into the per-second cap. Excess events queue.
 *   - **Budget.** Honors the same per-account daily LinkedIn ceiling as the
 *     `resolve-unipile-ids` cron (`linkedin_resolve_budget`); when the day's
 *     budget is spent it leaves the row `pending` for the cron rather than
 *     pushing LinkedIn past its limit.
 *   - **Correctness.** Routes through `unipileFetch` (v2) and applies the
 *     `realProviderId` guard so a slug is never stamped as a provider_id —
 *     the bug the cron was rebuilt to avoid. The legacy endpoint did both.
 *
 * On a 429 the row is left eligible (status `pending`, no attempt burned) so
 * the daily cron retries; only a real 404 / bad payload marks it terminally.
 */

const DEFAULT_DAILY_CAP = 80;
const MAX_RESOLVE_ATTEMPTS = 5;

export const resolvePersonOnDemand = inngest.createFunction(
  {
    id: "resolve-person-on-demand",
    name: "Resolve Unipile id for one person (on add)",
    retries: 2,
    // Serialize: one cold lookup at a time across the whole app so a bulk
    // add can't burst Unipile's 1-request/second profile-lookup cap.
    concurrency: [{ limit: 1 }],
  },
  { event: "people/resolve-unipile.requested" },
  async ({ event, logger }) => {
    const supabase = getSupabaseAdmin();
    const personId: string | undefined = event.data?.person_id;
    if (!personId) return { action: "skipped", reason: "no_person_id" };

    const { data: person } = await supabase
      .from("people")
      .select("id, linkedin_url, unipile_resolve_status, unipile_provider_id, unipile_resolve_attempts")
      .eq("id", personId)
      .maybeSingle();

    if (!person) return { action: "skipped", reason: "person_not_found" };
    // Already resolved → nothing to do (webhook can re-fire on unrelated updates).
    if (person.unipile_resolve_status === "resolved" && person.unipile_provider_id) {
      return { action: "skipped", reason: "already_resolved" };
    }
    if (!person.linkedin_url) return { action: "skipped", reason: "no_linkedin_url" };
    if ((person.unipile_resolve_attempts || 0) >= MAX_RESOLVE_ATTEMPTS) {
      return { action: "skipped", reason: "max_attempts" };
    }

    const slug = extractSlug(person.linkedin_url);
    if (!slug) {
      await markStatus(supabase, personId, "invalid_url", null);
      return { action: "skipped", reason: "invalid_url" };
    }

    const account = await pickAccount(supabase);
    if (!account) {
      // Leave eligible; the cron retries once an account reconnects.
      return { action: "skipped", reason: "no_unipile_account" };
    }

    // Daily LinkedIn budget — shared with the resolve-unipile-ids cron. When
    // it's spent, leave the row pending so the cron drains the rest tomorrow.
    const today = utcDate();
    const cap = await readDailyCap(supabase);
    const used = await readBudgetCount(supabase, account.id, today);
    if (used >= cap) {
      if (person.unipile_resolve_status !== "pending") {
        await markStatus(supabase, personId, "pending", "daily_budget_exhausted");
      }
      logger.info("On-demand resolve deferred — daily budget spent", { personId, used, cap });
      return { action: "deferred", reason: "daily_budget_exhausted" };
    }

    let profile: any;
    try {
      profile = await unipileFetch(
        supabase,
        account.unipile_account_id,
        `linkedin/users/${encodeURIComponent(slug)}`,
        { method: "GET", headers: { "X-UNIPILE-CLIENT": "sully-recruit" } },
      );
    } catch (err: any) {
      const msg = String(err?.message || "");
      const status = parseHttpStatus(msg);
      if (status === 429 || /limit|too many requests/i.test(msg)) {
        // Throttled — don't burn an attempt; the cron retries. Bump the
        // budget's throttle marker so the cron also backs off.
        await markStatus(supabase, personId, "pending", "throttled");
        await bumpBudget(supabase, account.id, today, true);
        logger.warn("On-demand resolve throttled — left pending", { personId });
        return { action: "throttled" };
      }
      if (status === 404) {
        await stampAttempt(supabase, person, "not_found", "profile_not_found");
        await bumpBudget(supabase, account.id, today, false);
        return { action: "not_found" };
      }
      await stampAttempt(supabase, person, "error", msg.slice(0, 200));
      await bumpBudget(supabase, account.id, today, false);
      logger.warn("On-demand resolve error", { personId, err: msg.slice(0, 200) });
      return { action: "error", reason: msg.slice(0, 200) };
    }

    const providerId = realProviderId(profile);
    const unipileId = profile?.id || null;
    const publicIdentifier = profile?.public_identifier || null;
    if (!providerId && !unipileId) {
      await stampAttempt(supabase, person, "error", "no_provider_id_in_payload");
      await bumpBudget(supabase, account.id, today, false);
      return { action: "error", reason: "no_provider_id_in_payload" };
    }

    // Classic account → unipile_classic_id; recruiter → unipile_recruiter_id.
    // Never write a slug into a provider-id column (realProviderId guards it).
    const idColumn: "unipile_classic_id" | "unipile_recruiter_id" =
      account.account_type === "linkedin_recruiter" ? "unipile_recruiter_id" : "unipile_classic_id";

    const enrichment: Record<string, any> = {
      unipile_resolve_status: "resolved",
      unipile_resolve_last_attempt_at: new Date().toISOString(),
      unipile_resolve_last_error: null,
      unipile_provider_id: providerId,
      unipile_public_identifier: publicIdentifier,
    };
    if (providerId) enrichment[idColumn] = providerId;
    if (profile?.headline) enrichment.linkedin_headline = profile.headline;
    const avatarUrl = profile?.profile_picture_url ?? profile?.picture_url ?? profile?.image_url ?? null;
    if (avatarUrl) enrichment.avatar_url = avatarUrl;

    const { error: peopleErr } = await supabase.from("people").update(enrichment).eq("id", personId);
    if (peopleErr) {
      logger.error("people update failed", { personId, err: peopleErr.message });
      await bumpBudget(supabase, account.id, today, false);
      return { action: "error", reason: peopleErr.message };
    }

    // Mirror to candidate_channels for the webhook/send cache path.
    await supabase.from("candidate_channels").upsert(
      {
        candidate_id: personId,
        channel: "linkedin",
        unipile_id: unipileId,
        provider_id: providerId,
        is_connected: true,
        account_id: account.id,
        connection_status: "resolved_on_add",
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "candidate_id,channel" },
    );

    await bumpBudget(supabase, account.id, today, false);
    logger.info("Resolved person on add", { personId, hasProviderId: !!providerId });
    return { action: "resolved", provider_id: providerId };
  },
);

// ── helpers (mirror resolve-unipile-ids.ts; kept inline to leave that
//    post-mortem-hardened cron file untouched) ─────────────────────────────

async function pickAccount(
  supabase: any,
): Promise<{ id: string; unipile_account_id: string; account_type: string | null } | null> {
  const { data } = await supabase
    .from("integration_accounts")
    .select("id, unipile_account_id, account_type")
    .or("account_type.eq.linkedin_classic,account_type.eq.linkedin,account_type.eq.linkedin_recruiter")
    .eq("is_active", true)
    .not("unipile_account_id", "is", null)
    .order("account_type", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function readDailyCap(supabase: any): Promise<number> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "LINKEDIN_RESOLVE_DAILY_CAP")
    .maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_CAP;
}

async function readBudgetCount(supabase: any, accountId: string, day: string): Promise<number> {
  const { data } = await supabase
    .from("linkedin_resolve_budget")
    .select("cold_lookups")
    .eq("account_id", accountId)
    .eq("day", day)
    .maybeSingle();
  return Number(data?.cold_lookups) || 0;
}

async function bumpBudget(supabase: any, accountId: string, day: string, throttled: boolean) {
  const current = await readBudgetCount(supabase, accountId, day);
  const patch: Record<string, any> = { cold_lookups: current + 1, updated_at: new Date().toISOString() };
  if (throttled) patch.throttled_at = new Date().toISOString();
  // Upsert so the per-day row is created on first lookup (the cron may not
  // have created it yet when an add comes in early in the day).
  await supabase
    .from("linkedin_resolve_budget")
    .upsert({ account_id: accountId, day, ...patch }, { onConflict: "account_id,day" });
}

async function markStatus(supabase: any, personId: string, status: string, err: string | null) {
  await supabase
    .from("people")
    .update({
      unipile_resolve_status: status,
      unipile_resolve_last_attempt_at: new Date().toISOString(),
      unipile_resolve_last_error: err,
    })
    .eq("id", personId);
}

async function stampAttempt(
  supabase: any,
  person: { id: string; unipile_resolve_attempts?: number | null },
  status: "not_found" | "error",
  err: string,
) {
  await supabase
    .from("people")
    .update({
      unipile_resolve_status: status,
      unipile_resolve_attempts: (person.unipile_resolve_attempts || 0) + 1,
      unipile_resolve_last_attempt_at: new Date().toISOString(),
      unipile_resolve_last_error: err,
    })
    .eq("id", person.id);
}

function realProviderId(profile: any): string | null {
  // Provider IDs look like `ACoAA…` (mixed-case URN encoding).
  // public_identifier is a lowercase slug — never store it as a provider id.
  const raw = profile?.provider_id;
  if (typeof raw !== "string") return null;
  if (/^[a-z0-9-]+$/.test(raw)) return null;
  if (raw.length < 16) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return raw;
}

function parseHttpStatus(msg: string): number | null {
  // unipileFetch throws `Unipile v2 <status> <path>: <body>`.
  const m = msg.match(/Unipile(?:\s+v2)?\s+(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

function extractSlug(url: string | null): string | null {
  const normalized = normalizeLinkedIn(url);
  if (normalized) return normalized;
  if (url && /^[\w-]+$/.test(url.trim())) return url.trim();
  return null;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}
