import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import {
  loadUnipileConfig,
  listLinkedinContracts,
  selectLinkedinContractByName,
} from "../lib/unipile-linkedin.js";
import { requireAuth } from "../lib/auth.js";

/**
 * Phase F — LinkedIn Recruiter contract selector
 *
 * The manifesto's Source-module hypothesis: the 403 "Insufficient
 * permissions" we get on every Recruiter call may be a missing
 * `selectContract` step, not a Unipile-side scope gate. Flow is
 *   listLinkedinContracts → selectLinkedinContractByName.
 * Both helpers already live in `unipile-linkedin.ts` — this endpoint
 * just exposes them to the admin UI so we can test the hypothesis
 * without shelling out to curl.
 *
 * Routes:
 *   GET  /api/admin/linkedin-contract?account_id=<unipile_account_id>
 *     → { contracts: [{ id, name }, ...] }
 *   POST /api/admin/linkedin-contract
 *     body: { account_id, contract_name }
 *     → { selected: { id, name } } or 404 if no match
 *
 * Auth: Supabase JWT (any signed-in user). Internal admin only —
 * picking the wrong contract on a multi-Recruiter seat can hide
 * pipelines from the user, so do this knowingly.
 *
 * Followup if this works: a) the Source module's listProjects /
 * pipeline endpoints start returning 200, b) we cache the selected
 * contract id on integration_accounts.metadata so subsequent runs
 * don't have to re-select. If this DOESN'T work, the manifesto's
 * hypothesis is wrong and we need a Unipile support ticket (see
 * CLAUDE.md's Unipile v1/v2 split notes).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!(await requireAuth(req, res))) return;

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const config = await loadUnipileConfig(supabase);

  if (req.method === "GET") {
    const accountId = String(req.query.account_id || "").trim();
    if (!accountId) return res.status(400).json({ error: "account_id query param required" });
    try {
      const contracts = await listLinkedinContracts(config, accountId);
      return res.status(200).json({ account_id: accountId, contracts });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "list-contracts failed" });
    }
  }

  if (req.method === "POST") {
    const { account_id, contract_name } = req.body ?? {};
    if (!account_id || !contract_name) {
      return res.status(400).json({ error: "Missing account_id or contract_name" });
    }
    try {
      const selected = await selectLinkedinContractByName(config, account_id, contract_name);
      if (!selected) {
        return res.status(404).json({ error: "No contract matched", contract_name });
      }
      return res.status(200).json({ selected });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "select-contract failed" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
