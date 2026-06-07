import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { callAIWithFallback } from "./lib/ai-fallback.js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/generate-linkedin-job-post
 *
 * Body: { job_id: string }
 *
 * Loads a job from `jobs` (joined to its `companies` row when present) and
 * asks the shared AI cascade (Claude → OpenAI → Gemini → OpenRouter, all four
 * keys passed) to write a polished, candidate-attracting LinkedIn job post.
 *
 * The tone is deliberately different from the internal job description: a
 * hook, 3-5 role highlights, a "why join" angle, a soft CTA, and a few
 * relevant hashtags — professional + on-brand, ~150-250 words.
 *
 * Returns: { post: string }
 *
 * Auth: standard Supabase JWT (or service-role key) — see api/lib/auth.ts.
 */

const SYSTEM_PROMPT = `You are a senior Wall Street recruiter at The Emerald Recruiting Group, a staffing firm that places talent at hedge funds, investment banks, prop trading shops, asset managers, and fintech companies.

Write a polished, candidate-ATTRACTING LinkedIn job post. This is marketing copy aimed at passive, high-caliber candidates scrolling LinkedIn — NOT the dry internal job spec.

Structure the post with:
- A strong opening HOOK (one or two punchy lines that grab attention).
- 3-5 role HIGHLIGHTS as short bullet points (use a leading marker like "•" or "→").
- A brief "WHY JOIN" angle that sells the opportunity (growth, impact, the calibre of the team, the market the firm operates in).
- A soft, inviting CALL TO ACTION (e.g. invite a DM or application — never pushy).
- A few (3-6) relevant, professional HASHTAGS on the final line.

Rules:
- Professional, confident, on-brand for a top-tier financial-services recruiting firm. No hype, no emoji spam (one or two tasteful emoji at most, optional).
- Keep it concise: roughly 150-250 words total.
- Do NOT invent specifics (exact comp numbers, company names, perks) that aren't supported by the details provided. If compensation is given, you may reference it tastefully (e.g. "competitive compensation"); never fabricate figures.
- If the company name is confidential/not provided, refer to it generically ("a leading hedge fund", "a top-tier asset manager") based on any industry hints.
- Return ONLY the post text itself — no preamble, no markdown headers, no surrounding quotes, no commentary.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already sent

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const jobId: string = String(req.body?.job_id ?? "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "Missing required field: job_id" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Load the job + (optionally) its company for richer context.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select(
      "id, title, company_name, location, description, compensation, additional_notes, submittal_instructions, " +
        "company:companies ( name, industry, description, size, hq_location )",
    )
    .eq("id", jobId)
    .is("deleted_at", null)
    .maybeSingle();

  if (jobErr) {
    return res.status(500).json({ error: `Failed to load job: ${jobErr.message}` });
  }
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // Load AI provider keys: env first, then app_settings fallback
  // (same cascade pattern as parse-email-signature / translate-job-spec).
  let anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.anthropic_api_key || "";
  let openaiKey = process.env.OPENAI_API_KEY || "";
  let geminiKey = process.env.GEMINI_API_KEY || "";
  let openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (!anthropicKey || !openaiKey || !geminiKey || !openRouterKey) {
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
    for (const row of data ?? []) {
      if (row.key === "ANTHROPIC_API_KEY" && !anthropicKey) anthropicKey = row.value;
      if (row.key === "OPENAI_API_KEY" && !openaiKey) openaiKey = row.value;
      if (row.key === "GEMINI_API_KEY" && !geminiKey) geminiKey = row.value;
      if (row.key === "OPENROUTER_API_KEY" && !openRouterKey) openRouterKey = row.value;
    }
  }
  if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
    return res.status(500).json({
      error: "No AI provider configured (need ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY)",
    });
  }

  // Supabase types a joined relation as an array | object depending on shape;
  // normalize to a single record for prompt building.
  const companyRaw = (job as any).company;
  const company = Array.isArray(companyRaw) ? companyRaw[0] : companyRaw;

  const companyName = (job as any).company_name || company?.name || "";
  const lines: string[] = [
    `Role title: ${(job as any).title || "(not specified)"}`,
    companyName ? `Company: ${companyName}` : "Company: (confidential / not specified)",
    (job as any).location ? `Location: ${(job as any).location}` : "",
    (job as any).compensation ? `Compensation: ${(job as any).compensation}` : "",
    company?.industry ? `Industry: ${company.industry}` : "",
    company?.size ? `Company size: ${company.size}` : "",
    company?.hq_location ? `Company HQ: ${company.hq_location}` : "",
    company?.description ? `About the company: ${String(company.description).slice(0, 800)}` : "",
    (job as any).description ? `Internal role description:\n${String((job as any).description).slice(0, 2500)}` : "",
    (job as any).additional_notes ? `Additional notes:\n${String((job as any).additional_notes).slice(0, 1000)}` : "",
  ].filter(Boolean);

  const userPrompt = `Write the LinkedIn job post based on these internal details:\n\n${lines.join("\n")}`;

  try {
    const { text } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      systemPrompt: SYSTEM_PROMPT,
      userContent: userPrompt,
      model: "claude-sonnet-4-6",
      maxTokens: 700,
      temperature: 0.7,
    });

    const post = (text || "").trim();
    if (!post) {
      return res.status(500).json({ error: "AI returned an empty post" });
    }
    return res.status(200).json({ post });
  } catch (err: any) {
    console.error("generate-linkedin-job-post error:", err?.message);
    return res.status(500).json({ error: `AI call failed: ${err?.message ?? "unknown"}` });
  }
}
