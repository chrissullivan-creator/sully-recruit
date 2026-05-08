import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/parse-resume
 *
 * Self-contained on purpose: no relative imports from src/lib. The
 * shared callAIWithFallback / extractResumeText helpers caused
 * ERR_MODULE_NOT_FOUND under Vercel's serverless ESM bundler when
 * crossed in a transitive chain (api → lib → lib). Inlining here
 * cuts the bundle's module graph to only node_modules + this file,
 * which is the configuration we know loads cleanly.
 *
 * Strategy: extract raw text via pdf-parse / mammoth / TextDecoder
 * (dynamic imports — failures fall through to "" and the AI gets a
 * useful error), then run Gemini → OpenAI for structured JSON.
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

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const verifierKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    serviceKey;
  const supabase = createClient(supabaseUrl, verifierKey);
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
    const rawText = await extractResumeText(fileBytes, fileName);
    if (!rawText || rawText.trim().length < 30) {
      return res.status(422).json({
        error: "Could not read text from this file. If it's a scanned/image-only PDF, please upload a text-based version.",
      });
    }

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
${rawText.slice(0, 60_000)}`;

    const systemPrompt =
      "You parse résumés into strict JSON matching the requested shape. Output null when a field is missing — never invent values.";

    const { text, via } = await callGeminiThenOpenAI({
      geminiKey, openaiKey,
      systemPrompt, userContent: userPrompt,
      maxTokens: 2048,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: "Resume parse: no JSON in response", via });
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ parsed, via });
  } catch (err: any) {
    console.error("Parse resume error:", err?.stack || err?.message || err);
    return res.status(500).json({
      error: err?.message || "parse-resume crashed",
      code: err?.code,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Inline helpers — kept here on purpose so this function has zero
// relative imports. Don't extract these without verifying the deploy
// still picks them up; transitive src/lib imports failed before
// (see file header).
// ──────────────────────────────────────────────────────────────────────

async function extractResumeText(
  fileBytes: ArrayBuffer | Uint8Array,
  fileName: string,
): Promise<string> {
  const lower = (fileName || "").toLowerCase();
  const buffer = Buffer.from(fileBytes as any);

  if (lower.endsWith(".txt")) {
    return new TextDecoder().decode(buffer).slice(0, 16_000);
  }

  if (lower.endsWith(".docx")) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.default.extractRawText({ buffer });
      return (result.value || "").trim().slice(0, 16_000);
    } catch (err: any) {
      console.warn("mammoth load/parse failed:", err?.message);
      return "";
    }
  }

  if (lower.endsWith(".pdf")) {
    try {
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const result = await Promise.race([
        pdfParse(buffer),
        new Promise<{ text: string }>((_, rej) =>
          setTimeout(() => rej(new Error("pdf-parse timeout 20s")), 20_000),
        ),
      ]);
      return (result.text || "").trim().slice(0, 16_000);
    } catch (err: any) {
      console.warn("pdf-parse load/parse failed:", err?.message);
      return "";
    }
  }

  return new TextDecoder().decode(buffer).slice(0, 16_000);
}

interface CallOpts {
  geminiKey: string;
  openaiKey: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
}

const FALLBACK_REGEX =
  /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key|overloaded|quota|exhausted|unavailable|503|500/i;

async function callGeminiThenOpenAI(opts: CallOpts): Promise<{ text: string; via: "gemini" | "openai" }> {
  // Gemini first. JSON-mode + low temperature for structured output.
  if (opts.geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(opts.geminiKey)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: opts.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: opts.userContent }] }],
          generationConfig: {
            maxOutputTokens: opts.maxTokens,
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
      });
      if (!resp.ok) {
        const body = (await resp.text()).slice(0, 400);
        throw new Error(`Gemini ${resp.status}: ${body}`);
      }
      const data = await resp.json();
      const text =
        (data.candidates?.[0]?.content?.parts || [])
          .map((p: any) => p.text || "")
          .join("") || "";
      if (!text) throw new Error("Gemini returned no text content");
      return { text, via: "gemini" };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (!FALLBACK_REGEX.test(msg) || !opts.openaiKey) throw err;
      console.warn("Gemini failed, falling back to OpenAI:", msg);
    }
  }

  // OpenAI fallback.
  if (opts.openaiKey) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: opts.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userContent },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("OpenAI returned no text content");
    return { text, via: "openai" };
  }

  throw new Error("callGeminiThenOpenAI: no provider keys supplied");
}
