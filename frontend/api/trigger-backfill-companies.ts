import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function to trigger the backfill-companies Trigger.dev task.
 * On-demand batch job for enriching company data from LinkedIn profiles.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { table, limit, mode, account_id } = req.body || {};

    const handle = await tasks.trigger("backfill-companies", {
      table: table ?? "both",
      limit: limit ?? 100,
      mode: mode ?? "local",
      accountId: account_id,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger backfill-companies error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
