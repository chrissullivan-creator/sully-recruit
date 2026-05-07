import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/status
 *
 * Pings each external dependency and returns a status payload that the
 * /status page renders. Public (read-only, no secrets in the response)
 * so recruiters who can't sign in can still tell whether the system or
 * their session is the problem.
 *
 * Each ping has a tight timeout so a slow upstream can't make the page
 * itself hang. We don't burn quota: the cheapest read on each service.
 */

interface CheckResult {
  name: string;
  ok: boolean;
  latency_ms: number | null;
  detail?: string;
}

const TIMEOUT_MS = 4000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms),
    ),
  ]);
}

async function check(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const out = await withTimeout(fn(), TIMEOUT_MS);
    return { name, ok: out.ok, latency_ms: Date.now() - t0, detail: out.detail };
  } catch (err: any) {
    return { name, ok: false, latency_ms: Date.now() - t0, detail: err.message };
  }
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Pull external creds from app_settings — same pattern as the rest of
  // the codebase, no env var sprawl.
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "UNIPILE_BASE_URL",
      "UNIPILE_BASE_V2_URL",
      "UNIPILE_API_KEY",
      "UNIPILE_API_KEY_V2",
      "MICROSOFT_GRAPH_CLIENT_ID",
      "MICROSOFT_GRAPH_CLIENT_SECRET",
      "MICROSOFT_GRAPH_TENANT_ID",
      "ANTHROPIC_API_KEY",
    ]);
  const cfg = new Map((settings ?? []).map((s: any) => [s.key, s.value]));

  const checks: CheckResult[] = await Promise.all([
    // Postgres — a trivial query against a real table.
    check("Postgres", async () => {
      const { error } = await supabase.from("app_settings").select("key").limit(1);
      return { ok: !error, detail: error?.message };
    }),

    // Microsoft Graph — token endpoint round-trip.
    check("Microsoft Graph", async () => {
      const tenantId = cfg.get("MICROSOFT_GRAPH_TENANT_ID");
      const clientId = cfg.get("MICROSOFT_GRAPH_CLIENT_ID");
      const clientSecret = cfg.get("MICROSOFT_GRAPH_CLIENT_SECRET");
      if (!tenantId || !clientId || !clientSecret) {
        return { ok: false, detail: "credentials missing" };
      }
      const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      });
      return { ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}` };
    }),

    // Unipile v2 — accounts endpoint (cheapest authenticated call).
    // Prefer the v2 settings, fall back to v1 settings (rewriting suffix).
    check("Unipile", async () => {
      const v2Base = (cfg.get("UNIPILE_BASE_V2_URL") || "").replace(/\/+$/, "")
        || (cfg.get("UNIPILE_BASE_URL") || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "/api/v2");
      const apiKey = cfg.get("UNIPILE_API_KEY_V2") || cfg.get("UNIPILE_API_KEY");
      if (!v2Base || !apiKey) return { ok: false, detail: "credentials missing" };
      const r = await fetch(`${v2Base}/accounts?limit=1`, {
        headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      });
      return { ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}` };
    }),

    // Anthropic — model list (no token spend).
    check("Anthropic", async () => {
      const key = cfg.get("ANTHROPIC_API_KEY");
      if (!key) return { ok: false, detail: "credentials missing" };
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      return { ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}` };
    }),

    // RingCentral — auth token endpoint (no SMS spend).
    check("RingCentral", async () => {
      // We don't have an env var for the JWT here; check that at least
      // *one* RC integration_account row has a non-expired token. If not,
      // the user needs to reconnect — that's a real "down" signal.
      const { data, error } = await supabase
        .from("integration_accounts")
        .select("id, rc_jwt")
        .eq("provider", "ringcentral")
        .eq("is_active", true)
        .not("rc_jwt", "is", null)
        .limit(1);
      if (error) return { ok: false, detail: error.message };
      if (!data || data.length === 0) return { ok: false, detail: "no active accounts" };
      return { ok: true };
    }),
  ]);

  const allOk = checks.every((c) => c.ok);
  res.setHeader("Cache-Control", "public, max-age=15");
  return res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    checked_at: new Date().toISOString(),
    checks,
  });
}
