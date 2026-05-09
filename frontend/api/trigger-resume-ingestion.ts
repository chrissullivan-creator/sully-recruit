import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the `ai/resume-ingestion.requested`
 * Inngest event. Called from ResumeDropZone after a candidate is saved,
 * and from Supabase DB webhooks on `resumes` INSERT.
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
      name: "ai/resume-ingestion.requested",
      data: { resumeId, candidateId, filePath, fileName },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger resume ingestion error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
