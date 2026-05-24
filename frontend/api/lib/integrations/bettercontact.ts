/**
 * BetterContact client — waterfall enrichment across 25+ providers.
 *
 * Two endpoints we use:
 *
 *   POST /v2/enrich           → submit a batch (1..many contacts).
 *                                Returns `{ id }` for polling.
 *   GET  /v2/enrich/{id}      → poll for completion. Returns
 *                                `{ status, data: [...] }`. `status`
 *                                is "in_progress" until the waterfall
 *                                finishes, then "terminated".
 *
 * Auth: BETTERCONTACT_API_KEY in app_settings (or env). Header:
 *   Authorization: Bearer <key>
 *
 * BetterContact validates emails as the last step of the waterfall, so
 * what comes back is already deliverable — no extra ZeroBounce pass
 * needed. Mobile numbers are sourced from carrier-grade providers
 * (TrueCaller, Skopenow, Telnyx HLR) and likewise trusted as-is.
 *
 * Pricing: pay-per-found, ~$0.10–0.20 per enriched contact depending
 * on which provider in the waterfall returned the data. Failed lookups
 * are free.
 *
 * Note: BetterContact's submit + poll pattern is inherently async. We
 * cap the poll loop at 30s so the enrich endpoint doesn't blow Vercel's
 * 60s function timeout when called on a single person. Bulk callers
 * should kick to Inngest instead.
 */

interface BetterContactConfig {
  apiKey: string;
}

let _cached: { config: BetterContactConfig; fetchedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;
const BASE = "https://app.bettercontact.rocks/api/v2";

export async function getBetterContactConfig(
  supabase: any,
): Promise<BetterContactConfig | null> {
  const envKey = process.env.BETTERCONTACT_API_KEY;
  if (envKey) return { apiKey: envKey };

  const now = Date.now();
  if (_cached && now - _cached.fetchedAt < CONFIG_TTL_MS) return _cached.config;

  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "BETTERCONTACT_API_KEY")
    .maybeSingle();
  const apiKey = row?.value;
  if (!apiKey) return null;

  const config = { apiKey };
  _cached = { config, fetchedAt: now };
  return config;
}

export interface BetterContactInput {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  company_domain?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
}

export interface BetterContactResult {
  email: string | null;
  /** Phone number BetterContact found — may be mobile or landline. */
  phone: string | null;
  /** True when BC explicitly tagged the number as mobile/cell. */
  phone_is_mobile: boolean;
  /** Provider in the waterfall that returned the data. */
  email_provider: string | null;
  phone_provider: string | null;
  raw: any;
}

/**
 * Enrich a single contact via BetterContact's waterfall. Submits, then
 * polls until the request terminates (or we hit the timeout). Returns
 * null on timeout or no-match so the cascade can fall through.
 *
 * `wantEmail` / `wantPhone` map to BC's `enrich_email_address` /
 * `enrich_phone_number` params — pass `false` to skip a leg of the
 * waterfall and save credits.
 */
export async function betterContactEnrich(
  config: BetterContactConfig,
  input: BetterContactInput,
  opts: { wantEmail?: boolean; wantPhone?: boolean; timeoutMs?: number } = {},
): Promise<BetterContactResult | null> {
  const wantEmail = opts.wantEmail ?? true;
  const wantPhone = opts.wantPhone ?? true;
  if (!wantEmail && !wantPhone) return null;

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // ── submit ─────────────────────────────────────────────────────
  let submitId: string | null = null;
  try {
    const resp = await fetch(`${BASE}/enrich`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: [
          {
            first_name: input.first_name ?? undefined,
            last_name: input.last_name ?? undefined,
            company: input.company ?? undefined,
            company_domain: input.company_domain ?? undefined,
            linkedin_url: input.linkedin_url ?? undefined,
            email: input.email ?? undefined,
          },
        ],
        enrich_email_address: wantEmail,
        enrich_phone_number: wantPhone,
      }),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    submitId = body?.id ?? body?.request_id ?? null;
  } catch {
    return null;
  }
  if (!submitId) return null;

  // ── poll until terminated ──────────────────────────────────────
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let pollDelay = 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollDelay));
    pollDelay = Math.min(pollDelay * 1.25, 4000);
    try {
      const resp = await fetch(`${BASE}/enrich/${submitId}`, { headers });
      if (!resp.ok) continue;
      const body = await resp.json();
      const status = String(body?.status ?? "").toLowerCase();
      if (status !== "terminated" && status !== "completed") continue;

      const row = Array.isArray(body?.data) ? body.data[0] : null;
      if (!row) return null;
      const phoneRaw = row?.contact_phone_number ?? row?.phone ?? null;
      const phoneType = String(row?.contact_phone_number_type ?? row?.phone_type ?? "").toLowerCase();
      return {
        email: row?.contact_email_address ?? row?.email ?? null,
        phone: phoneRaw,
        phone_is_mobile: phoneType === "mobile" || phoneType === "cell" || phoneType === "wireless",
        email_provider: row?.contact_email_address_provider ?? null,
        phone_provider: row?.contact_phone_number_provider ?? null,
        raw: row,
      };
    } catch {
      continue;
    }
  }
  return null; // timed out
}
