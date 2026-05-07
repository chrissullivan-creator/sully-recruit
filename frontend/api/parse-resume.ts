import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { extractResumeText } from "../src/lib/resume-parser";
import { callAIWithFallback } from "../src/lib/ai-fallback";

/**
 * POST /api/parse-resume
 *
 * Downloads a résumé from Supabase Storage, extracts raw text, and
 * runs Gemini → OpenAI fallback to produce structured JSON. No DB
 * writes — the calling dialog persists candidate fields itself.
 *
 * Eden AI / Affinda was retired. Gemini is the primary parser;
 * OpenAI is the fallback when Gemini hits quota or auth errors.
 *
 * Body: { filePath: string, fileName: string }
 * Auth: Supabase JWT (from logged-in user)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) {
    return res.status(500).json({ error: "Server misconfigured: missing Supabase credentials" });
  }

  // Auth: validate Supabase JWT
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { filePath, fileName } = req.body;
    if (!filePath || !fileName) {
      return res.status(400).json({ error: "Missing required fields: filePath, fileName" });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Resolve provider keys: env first, then app_settings.
    let geminiKey = process.env.GEMINI_API_KEY || "";
    let openaiKey = process.env.OPENAI_API_KEY || "";
    if (!geminiKey || !openaiKey) {
      const { data } = await admin
        .from("app_settings")
        .select("key, value")
        .in("key", ["GEMINI_API_KEY", "OPENAI_API_KEY"]);
      for (const row of data ?? []) {
        if (row.key === "GEMINI_API_KEY" && !geminiKey) geminiKey = row.value;
        if (row.key === "OPENAI_API_KEY" && !openaiKey) openaiKey = row.value;
      }
    }
    if (!geminiKey && !openaiKey) {
      return res.status(500).json({ error: "Resume parser: neither GEMINI_API_KEY nor OPENAI_API_KEY configured" });
    }

    const { data: downloadData, error: downloadErr } = await admin.storage
      .from("resumes")
      .download(filePath);
    if (downloadErr || !downloadData) {
      return res.status(500).json({
        error: `Failed to download file: ${downloadErr?.message || "no data"}`,
      });
    }

    const fileBytes = new Uint8Array(await downloadData.arrayBuffer());
    const rawText = await extractResumeText(fileBytes, fileName, {
      log: { warn: (m, meta) => console.warn(m, meta) },
    });

    const userPrompt = `Parse this resume into structured JSON. Return ONLY valid JSON, no markdown.

Extract:
{
  "first_name": "First",
  "last_name": "Last",
  "email": "email@example.com or null",
  "phone": "phone number or null",
  "linkedin_url": "linkedin URL or null",
  "current_title": "most recent job title",
  "current_company": "most recent company",
  "location": "city, state or null",
  "skills": ["skill1", "skill2"]
}

Resume text:
${rawText.slice(0, 60000)}`;

    const { text, via } = await callAIWithFallback({
      geminiKey: geminiKey || undefined,
      openaiKey: openaiKey || undefined,
      systemPrompt: "You parse résumés into strict JSON matching the requested shape. Output null when a field is missing — never invent values.",
      userContent: userPrompt,
      maxTokens: 2048,
      jsonOutput: true,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: "Resume parse: no JSON in response", via });
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ parsed, via });
  } catch (err: any) {
    console.error("Parse resume error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
