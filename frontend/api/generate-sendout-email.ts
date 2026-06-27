import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callAIWithFallback } from "./lib/ai-fallback.js";
import { requireAuth } from "./lib/auth.js";

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
      base_comp,
      bonus_comp,
      total_comp,
      right_to_work,
      additional_notes,
      job_title,
      job_company,
      job_description,
      contact_names,
      sender_name,
    } = req.body;

    if (!candidate_name) {
      return res.status(400).json({ error: "Missing required field: candidate_name" });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.anthropic_api_key || "";
    const openaiKey = process.env.OPENAI_API_KEY || "";
    const geminiKey = process.env.GEMINI_API_KEY || "";
    const openRouterKey = process.env.OPENROUTER_API_KEY || "";
    if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
      return res.status(500).json({ error: "No AI keys configured (need ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY)" });
    }

    const contactList = contact_names?.length ? contact_names.join(", ") : "the hiring team";

    // Prefer the explicit per-submission comp fields when present; fall back to
    // the legacy single `compensation` string.
    const compLines = [
      base_comp ? `Base: ${base_comp}` : "",
      bonus_comp ? `Bonus: ${bonus_comp}` : "",
      total_comp ? `Total comp: ${total_comp}` : "",
    ].filter(Boolean).join(" | ") || compensation || "";

    const userPrompt = `You are a senior Wall Street recruiter at The Emerald Recruiting Group. Write a sharp, direct client submission email presenting a candidate for a role.

Candidate: ${candidate_name}
${candidate_title ? `Current Title: ${candidate_title}` : ""}
${candidate_company ? `Current Company: ${candidate_company}` : ""}
${candidate_notes ? `Background notes: ${candidate_notes}` : ""}
${compLines ? `Compensation: ${compLines}` : ""}
${right_to_work ? `Right to work / work authorization: ${right_to_work}` : ""}
${additional_notes ? `Additional notes from the recruiter: ${additional_notes}` : ""}

${job_title ? `Role: ${job_title}` : ""}
${job_company ? `Company: ${job_company}` : ""}
${job_description ? `Description: ${job_description.slice(0, 1200)}` : ""}

Contact(s): ${contactList}
Sender: ${sender_name || "The Emerald Recruiting Group"}

Write the email so it is DIRECT and to the point: lead with why this specific candidate is right for THIS job, citing concrete, relevant experience. Naturally work in the compensation, right-to-work status, and any additional notes where they matter to the client. Keep it sharp — NOT salesy, NOT fluffy, no filler adjectives or hype. 2-3 short paragraphs max.

Return ONLY valid JSON with two fields:
{
  "greeting": "Hi [first name of first contact],",
  "body": "the email body (no greeting, no sign-off)."
}`;

    const { text } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      systemPrompt: "You write sharp, direct, no-fluff client-facing submission emails for a senior Wall Street recruiter.",
      userContent: userPrompt,
      model: "claude-sonnet-4-6",
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
