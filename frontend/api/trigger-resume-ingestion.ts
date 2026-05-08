import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to trigger the resume-ingestion Trigger.dev task.
 * Called from ResumeDropZone after a candidate is saved.
 * Also serves as the endpoint for Supabase database webhooks on resumes INSERT.
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

    const handle = await tasks.trigger("resume-ingestion", {
      resumeId,
      candidateId,
      filePath,
      fileName,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger resume ingestion error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
