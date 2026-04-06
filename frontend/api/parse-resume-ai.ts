import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * POST /api/parse-resume-ai
 * Parses raw resume text using Claude and returns structured data.
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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    const jobContext = job_title
      ? `\nJob context: ${job_title}${job_description ? ` — ${job_description.slice(0, 500)}` : ""}`
      : "";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: `Parse this resume into structured JSON. Return ONLY valid JSON, no markdown.${jobContext}

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
${resume_text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error: ${errText}`);
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || "";

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
