import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callAIWithFallback } from "./lib/ai-fallback";
import { requireAuth } from "./lib/auth";

/**
 * POST /api/generate-sendout-email
 * Generates a professional sendout/submission email using Claude.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const {
      candidate_name,
      candidate_title,
      candidate_company,
      candidate_notes,
      compensation,
      job_title,
      job_company,
      job_description,
      contact_names,
      sender_name,
    } = req.body;

    if (!candidate_name) {
      return res.status(400).json({ error: "Missing required field: candidate_name" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    const contactList = contact_names?.length ? contact_names.join(", ") : "the hiring team";

    const userPrompt = `You are a senior Wall Street recruiter at The Emerald Recruiting Group. Write a professional sendout/submission email presenting a candidate to a client for a role.

Candidate: ${candidate_name}
${candidate_title ? `Current Title: ${candidate_title}` : ""}
${candidate_company ? `Current Company: ${candidate_company}` : ""}
${candidate_notes ? `Notes: ${candidate_notes}` : ""}
${compensation ? `Compensation: ${compensation}` : ""}

${job_title ? `Role: ${job_title}` : ""}
${job_company ? `Company: ${job_company}` : ""}
${job_description ? `Description: ${job_description.slice(0, 1000)}` : ""}

Contact(s): ${contactList}
Sender: ${sender_name || "The Emerald Recruiting Group"}

Return ONLY valid JSON with two fields:
{
  "greeting": "Hi [first name of first contact],",
  "body": "the email body (no greeting, no sign-off). Be concise, professional, and highlight why this candidate is a strong fit. 2-3 short paragraphs max."
}`;

    const { text } = await callAIWithFallback({
      anthropicKey: apiKey,
      openaiKey: process.env.OPENAI_API_KEY,
      systemPrompt: "You write professional client-facing submission emails for a senior Wall Street recruiter.",
      userContent: userPrompt,
      model: "claude-sonnet-4-20250514",
      maxTokens: 1024,
      jsonOutput: true,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Failed to generate email");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return res.status(200).json(parsed);
  } catch (err: any) {
    console.error("generate-sendout-email error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
