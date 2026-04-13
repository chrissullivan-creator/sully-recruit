import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Kick off a one-time backfill of existing candidates to Outlook contacts.
 * Targets candidates in sequences or with meeting task links who haven't been synced yet.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const handle = await tasks.trigger("backfill-outlook-contacts", {});
    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger backfill-outlook-contacts error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
