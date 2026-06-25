import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/call/ringout
 *
 * RingCentral RingOut click-to-call. RingOut is a two-legged call: RingCentral
 * first rings the recruiter's own phone (the `from` number / extension), and
 * once they pick up it dials the candidate (`to`) and bridges the two legs.
 * The recruiter never has to dial — they just answer their own phone.
 *
 * Body: { to: string, candidate_id?: string, contact_id?: string }
 *
 * Auth: Supabase JWT (same pattern as add-person.ts via requireAuth).
 *
 * RC auth reuses the per-user JWT-bearer flow already proven in
 * server-lib/call-deepgram-runner.ts#getRCToken: POST {rcServer}/restapi/oauth/token
 * with Basic client_id:client_secret and assertion=rc_jwt. The OAuth app
 * credentials (rc_client_id / rc_client_secret) live in the integration_account
 * metadata; today they're only populated on the provider='sms' row, while the
 * caller-identity fields (rc_phone_number / rc_extension) live on provider='phone'.
 * We therefore gather BOTH of the user's RC rows and resolve each field from
 * whichever row carries it.
 *
 * Returns { ok: true, status } on success. On failure we surface RingCentral's
 * error verbatim — RingOut is a separately-toggled app scope, so a 403 here
 * almost always means "RingOut/Call Control isn't enabled on the RC app yet"
 * and the operator needs that exact text.
 */

const DEFAULT_RC_SERVER = "https://platform.ringcentral.com";

interface RcRow {
  id: string;
  provider: string;
  account_label: string | null;
  is_active: boolean;
  rc_jwt: string | null;
  rc_phone_number: string | null;
  rc_extension: string | null;
  access_token: string | null;
  token_expires_at: string | null;
  metadata: Record<string, any> | null;
}

/** Normalize a US phone number to E.164 (+1XXXXXXXXXX). Mirrors the DB
 *  normalize_us_phone() helper closely enough for dialing. Returns null if
 *  we can't make a plausible E.164 number out of it. */
function toE164(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  // Already E.164 (any country) — keep as-is if it looks sane.
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Other lengths: best-effort prefix with + so RC can try to route it.
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already written
  const userId = auth.userId;
  if (!userId) {
    // RingOut is inherently per-recruiter — we need a real user to pick the
    // from-number. Service-role callers have no phone identity.
    return res.status(400).json({ error: "RingOut requires a logged-in user" });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { to, candidate_id, contact_id, interview_id } = (req.body || {}) as {
    to?: string;
    candidate_id?: string;
    contact_id?: string;
    interview_id?: string;
  };

  const toNumber = toE164(to || "");
  if (!toNumber) {
    return res.status(400).json({ error: "Missing or invalid 'to' phone number" });
  }

  // ── Gather this user's RingCentral integration rows ──────────────────────
  // provider='phone' carries the caller identity (rc_phone_number / extension);
  // provider='sms' currently carries the OAuth app creds (rc_client_id/secret)
  // and the cached access_token. Pull both and merge.
  const { data: rcRows, error: rcErr } = await supabase
    .from("integration_accounts")
    .select(
      "id, provider, account_label, is_active, rc_jwt, rc_phone_number, rc_extension, access_token, token_expires_at, metadata",
    )
    .eq("owner_user_id", userId)
    .in("provider", ["phone", "sms"])
    .eq("is_active", true);

  if (rcErr) {
    return res.status(500).json({ error: `Failed to load RingCentral account: ${rcErr.message}` });
  }
  const rows = (rcRows || []) as RcRow[];
  if (rows.length === 0) {
    return res.status(404).json({
      error: "No active RingCentral account on your profile. Connect RingCentral in Settings first.",
    });
  }

  // Prefer the 'phone' row for caller identity, fall back to 'sms'.
  const phoneRow = rows.find((r) => r.provider === "phone");
  const smsRow = rows.find((r) => r.provider === "sms");
  const identityRow = phoneRow || smsRow!;

  const fromNumber = identityRow.rc_phone_number || smsRow?.rc_phone_number || phoneRow?.rc_phone_number || null;
  const fromExtension = identityRow.rc_extension || smsRow?.rc_extension || phoneRow?.rc_extension || null;
  if (!fromNumber && !fromExtension) {
    return res.status(400).json({
      error: "Your RingCentral account has no phone number or extension on file — re-connect RingCentral.",
    });
  }

  // Resolve OAuth creds + jwt from whichever row has them.
  const meta = (smsRow?.metadata || phoneRow?.metadata || {}) as Record<string, any>;
  const clientId = smsRow?.metadata?.rc_client_id || phoneRow?.metadata?.rc_client_id;
  const clientSecret = smsRow?.metadata?.rc_client_secret || phoneRow?.metadata?.rc_client_secret;
  const rcJwt = smsRow?.rc_jwt || phoneRow?.rc_jwt;
  const rcServer = meta.rc_server_url || DEFAULT_RC_SERVER;

  // ── Get an access token: reuse cached one, else JWT-bearer refresh ────────
  // The cached token (if any) lives on the sms row alongside the creds.
  let accessToken: string | null = null;
  const credRow = smsRow?.metadata?.rc_client_id ? smsRow : phoneRow;
  if (
    credRow?.access_token &&
    credRow.token_expires_at &&
    new Date(credRow.token_expires_at) > new Date(Date.now() + 60_000)
  ) {
    accessToken = credRow.access_token;
  }

  if (!accessToken) {
    if (!clientId || !clientSecret || !rcJwt) {
      return res.status(400).json({
        error:
          "RingCentral account is missing OAuth credentials (rc_client_id / rc_client_secret / rc_jwt). Re-connect RingCentral in Settings.",
      });
    }
    const tokenResp = await fetch(`${rcServer}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: rcJwt,
      }),
    });
    if (!tokenResp.ok) {
      const body = (await tokenResp.text().catch(() => "")).slice(0, 500);
      return res.status(502).json({
        error: `RingCentral auth failed (${tokenResp.status}): ${body || "no detail"}`,
      });
    }
    const tok = (await tokenResp.json()) as { access_token?: string; expires_in?: number };
    accessToken = tok.access_token ?? null;
    // Persist the fresh token on the row that owns the creds so the next
    // RingOut (and the deepgram pipeline) can reuse it.
    if (credRow) {
      await supabase
        .from("integration_accounts")
        .update({
          access_token: tok.access_token,
          token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", credRow.id);
    }
  }

  // ── Fire the RingOut ─────────────────────────────────────────────────────
  // `from` must be a number the extension owns. We send phoneNumber when we
  // have it (most reliable), else fall back to the extension number.
  const fromPayload: Record<string, string> = {};
  if (fromNumber) fromPayload.phoneNumber = fromNumber;
  else if (fromExtension) fromPayload.extensionNumber = fromExtension;

  const ringOutResp = await fetch(
    `${rcServer}/restapi/v1.0/account/~/extension/~/ring-out`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromPayload,
        to: { phoneNumber: toNumber },
        playPrompt: false,
      }),
    },
  );

  if (!ringOutResp.ok) {
    const body = (await ringOutResp.text().catch(() => "")).slice(0, 800);
    // Surface RC's error verbatim. A 403 here is almost always the RingOut /
    // Call Control scope not being enabled on the RC app.
    const hint =
      ringOutResp.status === 403
        ? " (this usually means the RingOut/Call Control scope is not enabled on the RingCentral app)"
        : "";
    return res.status(ringOutResp.status === 403 ? 403 : 502).json({
      error: `RingCentral RingOut failed (${ringOutResp.status})${hint}: ${body || "no detail"}`,
    });
  }

  const ringOut = (await ringOutResp.json().catch(() => ({}))) as {
    id?: string | number;
    status?: { callStatus?: string; callerStatus?: string };
  };
  const callStatus =
    ringOut?.status?.callStatus || ringOut?.status?.callerStatus || "InProgress";
  const externalCallId = ringOut?.id != null ? String(ringOut.id) : null;

  // ── Best-effort: log the attempt to call_logs so it shows on the timeline ─
  // Never let logging failure break the call — the phone is already ringing.
  try {
    await supabase.from("call_logs").insert({
      owner_id: userId,
      phone_number: toNumber,
      direction: "outbound",
      status: "in_progress",
      external_call_id: externalCallId,
      candidate_id: candidate_id || null,
      contact_id: contact_id || null,
      interview_id: interview_id || null,
      linked_entity_type: candidate_id ? "candidate" : contact_id ? "contact" : null,
      linked_entity_id: candidate_id || contact_id || null,
    } as any);
  } catch {
    /* timeline logging is non-critical */
  }

  return res.status(200).json({ ok: true, status: callStatus });
}
