import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * Register a shared M365 mailbox as a usable send-from / inbox-sync
 * account in Sully Recruit. The owner_user_id's existing Microsoft
 * access token (with delegated Mail.Send.Shared + Mail.ReadWrite.Shared
 * scopes) is reused — no separate OAuth per shared mailbox.
 *
 * Usage:
 *   curl -X POST https://<vercel-app>/api/admin/register-shared-mailbox \
 *     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{
 *           "owner_user_id": "fc07e240-0e31-45d4-a8f1-ddec1042dd5f",
 *           "shared_email": "sullivan@bd.emeraldrecruit.com",
 *           "account_label": "Sullivan @ BD (shared)"
 *         }'
 *
 * Flow:
 *   1. Pull the owner's existing email integration_account row →
 *      grabs access_token + refresh_token (delegated to that user).
 *   2. Call Graph `GET /users/{shared_email}` to verify access and
 *      pick up the shared mailbox's user id.
 *   3. INSERT a new integration_accounts row with provider='email',
 *      account_type='email', email_address=<shared_email>, and the
 *      SAME access_token / refresh_token as the owner (Graph treats
 *      delegated-shared access as one token across mailboxes).
 *
 * Pre-reqs (the operator confirms):
 *   - Owner has reconnected Microsoft after the .Shared scopes were
 *     added to microsoft-oauth (commit added 2026-05-12).
 *   - Owner has at least "Send As" or "Full Access" on the shared
 *     mailbox in M365 admin.
 *
 * The row created here is enough for sendEmail to route through
 * Graph's /users/{shared}/sendMail path. Inbound sync (Graph webhook
 * subscription + backfill-emails coverage) is a separate Stage-2
 * follow-up.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY not configured" });
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (got !== expected) return res.status(401).json({ error: "Unauthorized" });

  const ownerUserId = String(req.body?.owner_user_id || "");
  const sharedEmail = String(req.body?.shared_email || "").toLowerCase().trim();
  const accountLabel = String(req.body?.account_label || sharedEmail);

  if (!ownerUserId || !sharedEmail) {
    return res.status(400).json({ error: "owner_user_id and shared_email are required" });
  }
  if (!sharedEmail.includes("@")) {
    return res.status(400).json({ error: "shared_email must be a valid address" });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Supabase env not configured" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. Find owner's primary email integration_account (must have token + microsoft_user_id)
  const { data: ownerAccount, error: ownerErr } = await supabase
    .from("integration_accounts")
    .select("id, owner_user_id, access_token, refresh_token, token_expires_at, microsoft_user_id, email_address")
    .eq("owner_user_id", ownerUserId)
    .eq("provider", "email")
    .eq("is_active", true)
    .not("access_token", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ownerErr || !ownerAccount?.access_token) {
    return res.status(404).json({
      error: "No active email integration_account with an access_token found for owner_user_id",
      hint: "Reconnect Microsoft in Settings first.",
    });
  }

  // 2. Verify Graph access to the shared mailbox using the owner's token.
  const verifyResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sharedEmail)}?$select=id,displayName,mail,userPrincipalName`,
    { headers: { Authorization: `Bearer ${ownerAccount.access_token}` } },
  );
  if (!verifyResp.ok) {
    const text = await verifyResp.text().catch(() => "");
    return res.status(verifyResp.status).json({
      error: `Graph could not access ${sharedEmail}`,
      status: verifyResp.status,
      detail: text.slice(0, 400),
      hint: verifyResp.status === 403
        ? "Owner's token is missing Mail.Send.Shared / Mail.ReadWrite.Shared, or M365 admin hasn't granted owner Send-As on this mailbox. Reconnect Microsoft after the .Shared scopes are deployed."
        : verifyResp.status === 404
          ? "Shared mailbox not found at this address in the tenant."
          : undefined,
    });
  }
  const sharedUser = await verifyResp.json();

  // 3. Idempotent insert — return existing row if it's already there.
  const { data: existing } = await supabase
    .from("integration_accounts")
    .select("id, email_address, owner_user_id")
    .eq("email_address", sharedEmail)
    .eq("provider", "email")
    .maybeSingle();
  if (existing) {
    return res.status(200).json({
      ok: true, alreadyExisted: true, integration_account_id: existing.id,
      shared_email: sharedEmail, microsoft_user_id: sharedUser.id,
    });
  }

  // Use the same delegated token as the owner — Graph honors it for the
  // shared mailbox path because of the .Shared scopes.
  const { data: created, error: insertErr } = await supabase
    .from("integration_accounts")
    .insert({
      owner_user_id: ownerUserId,
      provider: "email",
      account_type: "email",
      account_label: accountLabel,
      email_address: sharedEmail,
      microsoft_user_id: sharedUser.id || null,
      mailbox_identifier: sharedEmail,
      access_token: ownerAccount.access_token,
      refresh_token: ownerAccount.refresh_token,
      token_expires_at: ownerAccount.token_expires_at,
      auth_provider: "microsoft",
      is_active: true,
      // metadata flag so we can find shared rows later (UI badges, etc.)
      metadata: { kind: "shared_mailbox", source_owner_account_id: ownerAccount.id } as any,
    } as any)
    .select("id")
    .single();

  if (insertErr || !created) {
    return res.status(500).json({ error: insertErr?.message || "Insert failed" });
  }

  return res.status(200).json({
    ok: true,
    integration_account_id: created.id,
    shared_email: sharedEmail,
    microsoft_user_id: sharedUser.id,
    display_name: sharedUser.displayName,
  });
}
