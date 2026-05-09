import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/trigger-resume-ingestion
 * body: { resumeId, candidateId, filePath, fileName }
 *
 * Fires `resume/ingest-requested` into Inngest. Called from
 * ResumeDropZone after a candidate is saved, plus Supabase DB webhook
 * on resumes INSERT.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const { resumeId, candidateId, filePath, fileName } = req.body;

    if (!resumeId || !candidateId || !filePath || !fileName) {
      return res.status(400).json({ error: "Missing required fields: resumeId, candidateId, filePath, fileName" });
    }

    const { ids } = await inngest.send({
      // resumeId is unique per upload, so the bare event id dedupes
      // duplicate POSTs (typical when the DB webhook + frontend both
      // fire on the same insert).
      id: `resume-ingest-${resumeId}`,
      name: "resume/ingest-requested",
      data: { resumeId, candidateId, filePath, fileName },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger resume/ingest-requested error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
