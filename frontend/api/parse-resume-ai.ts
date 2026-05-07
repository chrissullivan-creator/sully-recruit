import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { callAIWithFallback } from "../src/lib/ai-fallback";

/**
 * POST /api/parse-resume-ai
 * Parses raw resume text via Gemini → OpenAI fallback and returns
 * structured JSON.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { resume_text, job_title, job_description } = req.body;

    if (!resume_text) {
      return res.status(400).json({ error: "Missing required field: resume_text" });
    }

    // Pull keys from env first, falling back to app_settings so the
    // function works regardless of which deployment surface stored
    // them. Gemini is the primary; OpenAI is the fallback.
    let geminiKey = process.env.GEMINI_API_KEY || "";
    let openaiKey = process.env.OPENAI_API_KEY || "";
    if (!geminiKey || !openaiKey) {
      const supaUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
      const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supaUrl && svc) {
        const admin = createClient(supaUrl, svc);
        const { data } = await admin
          .from("app_settings")
          .select("key, value")
          .in("key", ["GEMINI_API_KEY", "OPENAI_API_KEY"]);
        for (const row of data ?? []) {
          if (row.key === "GEMINI_API_KEY" && !geminiKey) geminiKey = row.value;
          if (row.key === "OPENAI_API_KEY" && !openaiKey) openaiKey = row.value;
        }
      }
    }
    if (!geminiKey && !openaiKey) {
      return res.status(500).json({ error: "Resume parser: neither GEMINI_API_KEY nor OPENAI_API_KEY configured" });
    }

    const jobContext = job_title
      ? `\nJob context: ${job_title}${job_description ? ` — ${job_description.slice(0, 500)}` : ""}`
      : "";

    const userPrompt = `Parse this resume into structured JSON. Return ONLY valid JSON, no markdown.${jobContext}

Extract:
{
  "name": "Full Name",
  "email": "email@example.com or null",
  "phone": "phone number or null",
  "linkedin_url": "linkedin URL or null",
  "current_title": "most recent job title",
  "current_company": "most recent company",
  "location": "city, state or null",
  "summary": "2-3 sentence professional summary",
  "experience": [
    { "title": "Job Title", "company": "Company", "dates": "Start - End", "description": "brief description" }
  ],
  "education": [
    { "school": "School Name", "degree": "Degree", "year": "Graduation year" }
  ],
  "skills": ["skill1", "skill2"],
  "certifications": ["cert1"]
}

Resume text:
${resume_text}`;

    const { text } = await callAIWithFallback({
      geminiKey: geminiKey || undefined,
      openaiKey: openaiKey || undefined,
      systemPrompt: "You parse resumes into structured JSON.",
      userContent: userPrompt,
      maxTokens: 2048,
      jsonOutput: true,
    });

    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Failed to extract structured data from resume");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ data: parsed });
  } catch (err: any) {
    console.error("parse-resume-ai error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
