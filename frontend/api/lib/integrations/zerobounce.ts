/**
 * ZeroBounce email verification client.
 *
 * One endpoint: GET /v2/validate?api_key=...&email=...
 *
 * Returns a JSON envelope with a `status` field. Documented values:
 *   valid          deliverable
 *   invalid        non-deliverable (bad syntax, no MX, no inbox)
 *   catch-all      domain accepts everything — may bounce silently
 *   unknown        SMTP timed out, can't determine
 *   spamtrap       known trap address
 *   abuse          known complainer
 *   do_not_mail    role address, disposable, etc. (sub_status carries reason)
 *
 * In the cascade we treat `valid` and `catch-all` as acceptable to
 * write. `unknown` is also a soft-pass — ZeroBounce returns it for
 * legitimate addresses sometimes (corporate firewalls that block SMTP
 * probes). Everything else → drop.
 *
 * Auth: ZEROBOUNCE_API_KEY in app_settings (or env).
 * Pricing: ~$0.003/check, no monthly minimum on the smallest plan.
 */

interface ZeroBounceConfig {
  apiKey: string;
}

let _cached: { config: ZeroBounceConfig; fetchedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

export async function getZeroBounceConfig(
  supabase: any,
): Promise<ZeroBounceConfig | null> {
  const envKey = process.env.ZEROBOUNCE_API_KEY;
  if (envKey) return { apiKey: envKey };

  const now = Date.now();
  if (_cached && now - _cached.fetchedAt < CONFIG_TTL_MS) return _cached.config;

  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "ZEROBOUNCE_API_KEY")
    .maybeSingle();
  const apiKey = row?.value;
  if (!apiKey) return null;

  const config = { apiKey };
  _cached = { config, fetchedAt: now };
  return config;
}

export interface ZeroBounceResult {
  status: string;
  sub_status: string | null;
  /** True when we'd be comfortable writing this email back to the row. */
  acceptable: boolean;
  raw: any;
}

const ACCEPTABLE_STATUSES = new Set(["valid", "catch-all", "unknown"]);

/**
 * Remaining credit count. Returns null on any failure so the caller
 * (credit-alert cron) can flag the provider as "unknown" rather than
 * fall over.
 */
export async function zerobounceGetCredits(
  config: ZeroBounceConfig,
): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(config.apiKey)}`,
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const n = Number(data?.Credits ?? data?.credits);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function zerobounceValidate(
  config: ZeroBounceConfig,
  email: string,
): Promise<ZeroBounceResult | null> {
  if (!email) return null;
  const url =
    `https://api.zerobounce.net/v2/validate` +
    `?api_key=${encodeURIComponent(config.apiKey)}` +
    `&email=${encodeURIComponent(email)}`;
  try {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) return null;
    const data = await resp.json();
    const status = String(data?.status ?? "").toLowerCase();
    return {
      status,
      sub_status: data?.sub_status ?? null,
      acceptable: ACCEPTABLE_STATUSES.has(status),
      raw: data,
    };
  } catch {
    return null;
  }
}
