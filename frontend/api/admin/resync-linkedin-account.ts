import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { syncLinkedinIntegrationAccount } from "../lib/unipile-linkedin.js";
import { requireAuth } from "../lib/auth.js";

/**
 * Admin endpoint to re-run the LinkedIn sync against a Unipile account
 * that was reconnected out-of-band (e.g. unipile_account_id was swapped
 * directly in the DB). Calls syncLinkedinIntegrationAccount which
 * re-fetches account details, re-runs the Recruiter projects probe, and
 * refreshes linkedin_capability/capabilities + metadata in place.
 *
 *   curl -X POST https://<vercel-app>/api/admin/resync-linkedin-account \
 *     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"integration_account_id": "662645a9-1f9b-4220-9933-56a75923016e"}'
 *
 * Auth: Supabase JWT (any signed-in user) OR SUPABASE_SERVICE_ROLE_KEY.
 *
 * Optional body fields:
 *   contract_name  — override the Recruiter contract to bind (default: reuse existing)
 *   unipile_account_id — override (default: pulled from the row)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  const integrationAccountId = String(req.body?.integration_account_id || "").trim();
  if (!integrationAccountId) {
    return res.status(400).json({ error: "integration_account_id is required" });
  }

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: row, error } = await supabase
    .from("integration_accounts")
    .select("id, owner_user_id, unipile_account_id, account_label, metadata, provider")
    .eq("id", integrationAccountId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!row) return res.status(404).json({ error: "integration_account not found" });
  if (row.provider !== "linkedin") {
    return res.status(400).json({ error: `row provider is ${row.provider}, not linkedin` });
  }

  const unipileAccountId = String(req.body?.unipile_account_id || row.unipile_account_id || "").trim();
  if (!unipileAccountId) {
    return res.status(400).json({ error: "no unipile_account_id on row and none provided" });
  }

  const contractName =
    (typeof req.body?.contract_name === "string" && req.body.contract_name.trim()) ||
    (row.metadata as any)?.recruiter_contract_name ||
    null;

  try {
    const sync = await syncLinkedinIntegrationAccount(supabase, {
      accountLabel: row.account_label || null,
      authMethod: "hosted",
      contractName,
      integrationAccountId: row.id,
      ownerUserId: row.owner_user_id,
      requestedByUserId: row.owner_user_id,
      unipileAccountId,
    });

    return res.status(200).json({
      ok: true,
      integration_account_id: sync.integrationAccount.id,
      unipile_account_id: sync.integrationAccount.unipile_account_id,
      account_type: sync.integrationAccount.account_type,
      linkedin_capability: sync.integrationAccount.linkedin_capability,
      linkedin_capabilities: sync.integrationAccount.linkedin_capabilities,
      recruiter_enabled: sync.recruiterEnabled,
      contract: sync.contract,
      warnings: sync.warnings,
    });
  } catch (err: any) {
    console.error("resync-linkedin-account error", err?.message);
    return res.status(500).json({ error: err?.message || "unknown" });
  }
}
