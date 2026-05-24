/**
 * FullEnrich client — waterfall enrichment, similar shape to
 * BetterContact but with their own (~15-provider) waterfall.
 *
 * Two endpoints:
 *
 *   POST /v1/contact/enrich/bulk         → submit a batch.
 *                                            Returns `{ enrichment_id }`.
 *   GET  /v1/contact/enrich/bulk/{id}    → poll until status === "FINISHED".
 *
 * Auth: FULLENRICH_API_KEY in app_settings (or env). Header:
 *   Authorization: Bearer <key>
 *
 * FullEnrich runs SMTP verification as the last step, so returned
 * emails are already verified (status `valid` or `risky`). We treat
 * `valid` only as acceptable to write — `risky` falls through to the
 * next provider in the cascade.
 *
 * FullEnrich is the strongest provider for **personal emails** in our
 * cascade (it aggregates Hunter, Apollo, Findymail, etc. for B2C).
 * It's the work-email second pick after Apollo for B2B.
 *
 * Pricing: 1 credit per enrichment field returned (~$0.05–$0.10
 * each). Failed lookups are free.
 */

interface FullEnrichConfig {
  apiKey: string;
}

let _cached: { config: FullEnrichConfig; fetchedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;
const BASE = "https://app.fullenrich.com/api/v1";

export async function getFullEnrichConfig(
  supabase: any,
): Promise<FullEnrichConfig | null> {
  const envKey = process.env.FULLENRICH_API_KEY;
  if (envKey) return { apiKey: envKey };

  const now = Date.now();
  if (_cached && now - _cached.fetchedAt < CONFIG_TTL_MS) return _cached.config;

  const { data: row } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "FULLENRICH_API_KEY")
    .maybeSingle();
  const apiKey = row?.value;
  if (!apiKey) return null;

  const config = { apiKey };
  _cached = { config, fetchedAt: now };
  return config;
}

export interface FullEnrichInput {
  firstname?: string | null;
  lastname?: string | null;
  company_name?: string | null;
  domain?: string | null;
  linkedin_url?: string | null;
}

export type FullEnrichField = "contact_email_professional" | "contact_email_personal" | "contact_phone";

export interface FullEnrichResult {
  professional_email: string | null;
  professional_email_status: string | null; // valid | risky | invalid
  personal_email: string | null;
  personal_email_status: string | null;
  phone: string | null;
  raw: any;
}

/**
 * Enrich a single contact. Submits a bulk batch with one entry, then
 * polls until completion (or timeout).
 *
 * `fields` controls which legs of the waterfall to run — pass only
 * what you actually want so we don't pay for unused credits.
 */
export async function fullEnrichContact(
  config: FullEnrichConfig,
  input: FullEnrichInput,
  fields: FullEnrichField[],
  opts: { timeoutMs?: number } = {},
): Promise<FullEnrichResult | null> {
  if (fields.length === 0) return null;

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // ── submit ─────────────────────────────────────────────────────
  let enrichmentId: string | null = null;
  try {
    const resp = await fetch(`${BASE}/contact/enrich/bulk`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `sully-${Date.now()}`,
        datas: [
          {
            firstname: input.firstname ?? undefined,
            lastname: input.lastname ?? undefined,
            company_name: input.company_name ?? undefined,
            domain: input.domain ?? undefined,
            linkedin_url: input.linkedin_url ?? undefined,
            enrich_fields: fields,
          },
        ],
      }),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    enrichmentId = body?.enrichment_id ?? body?.id ?? null;
  } catch {
    return null;
  }
  if (!enrichmentId) return null;

  // ── poll until done ────────────────────────────────────────────
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let pollDelay = 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollDelay));
    pollDelay = Math.min(pollDelay * 1.25, 4000);
    try {
      const resp = await fetch(`${BASE}/contact/enrich/bulk/${enrichmentId}`, { headers });
      if (!resp.ok) continue;
      const body = await resp.json();
      const status = String(body?.status ?? "").toUpperCase();
      if (status !== "FINISHED" && status !== "COMPLETED") continue;

      const row = Array.isArray(body?.datas) ? body.datas[0] : Array.isArray(body?.data) ? body.data[0] : null;
      if (!row) return null;

      // FullEnrich nests contact data under various keys depending on
      // the field requested. Be defensive.
      const proEmails = row?.contact?.emails ?? row?.emails ?? [];
      const proEmail = Array.isArray(proEmails)
        ? proEmails.find((e: any) => e?.type === "professional" || e?.kind === "professional")
        : null;
      const personalEmail = Array.isArray(proEmails)
        ? proEmails.find((e: any) => e?.type === "personal" || e?.kind === "personal")
        : null;
      const phoneRaw = row?.contact?.phones?.[0]?.number ?? row?.phones?.[0]?.number ?? row?.phone ?? null;

      return {
        professional_email: proEmail?.email ?? proEmail?.value ?? null,
        professional_email_status: proEmail?.status ?? null,
        personal_email: personalEmail?.email ?? personalEmail?.value ?? null,
        personal_email_status: personalEmail?.status ?? null,
        phone: phoneRaw,
        raw: row,
      };
    } catch {
      continue;
    }
  }
  return null;
}
