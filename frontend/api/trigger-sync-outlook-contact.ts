import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Trigger Outlook contact sync for a candidate.
 * Called by pg_net DB triggers on candidates, sequence_enrollments, and task_links.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { candidate_id, candidate_ids } = req.body;

    // Batch mode: sync multiple candidates
    if (candidate_ids && Array.isArray(candidate_ids)) {
      const handles = await Promise.all(
        candidate_ids.map((id: string) =>
          tasks.trigger("sync-outlook-contact", { candidateId: id }),
        ),
      );
      return res.status(200).json({ triggered: true, count: handles.length });
    }

    // Single mode
    if (!candidate_id) {
      return res.status(400).json({ error: "Missing required field: candidate_id" });
    }

    const handle = await tasks.trigger("sync-outlook-contact", {
      candidateId: candidate_id,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger sync-outlook-contact error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
