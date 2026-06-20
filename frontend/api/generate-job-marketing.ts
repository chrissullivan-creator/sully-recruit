import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { callAIWithFallback } from "./lib/ai-fallback.js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/generate-job-marketing
 *
 * Body: { job_id: string }
 *
 * Loads a job (joined to its company) and asks the AI cascade to turn the
 * INTERNAL role details into polished, public/website-facing marketing copy
 * for the five jobs.marketing_* fields.
 *
 * Provider order is OpenAI → Claude → Gemini → OpenRouter (OpenAI leads, Claude
 * is the first fallback) — all keys are passed so any can answer.
 *
 * Returns: { marketing: {
 *   marketing_title, marketing_type_of_firm, marketing_job_location,
 *   marketing_job_compensation, marketing_job_description
 * }, via }
 *
 * Auth: standard Supabase JWT (or service-role key) — see api/lib/auth.ts.
 */

const SYSTEM_PROMPT = `You are Joe, the AI assistant at The Emerald Recruiting Group, a staffing firm that places talent at hedge funds, investment banks, prop trading shops, asset managers, and fintech companies.

Turn the INTERNAL job details provided into polished, public, website-facing MARKETING copy. This copy appears on the firm's public website to attract high-caliber candidates — it is NOT the dry internal spec.

Return ONLY a JSON object with EXACTLY these string fields:
- "marketing_title": a crisp, attractive public job title (e.g. "Senior Quantitative Researcher — Systematic Macro"). Plain text, no quotes.
- "marketing_type_of_firm": a short description of the firm type, anonymized if the company is confidential (e.g. "Multi-strategy hedge fund", "Top-tier proprietary trading firm"). Plain text.
- "marketing_job_location": a clean, public-facing location string (e.g. "New York, NY (Hybrid)"). Plain text.
- "marketing_job_compensation": tasteful public compensation copy. If figures are provided you may reference them; otherwise use language like "Competitive base + bonus". NEVER fabricate specific numbers. Plain text.
- "marketing_job_description": a compelling public role description as simple HTML, broken into EXACTLY these three sections, in this order, each introduced by an <h3> heading with the exact title shown:
    1. <h3>What You'll Be Doing</h3> — a short intro <p> and/or a <ul> of the core responsibilities/day-to-day.
    2. <h3>Who We're Looking For</h3> — a <ul> of the key qualifications, experience, and skills.
    3. <h3>Why This Role</h3> — a punchy <p> that sells the opportunity (the "sizzle": growth, impact, team calibre, the firm/market).
  Use ONLY <h3>, <p>, <ul>, <li>, <strong>, and <em> tags. Roughly 150-260 words total across the three sections.

Rules:
- Professional, confident, on-brand for a top-tier financial-services recruiting firm. No emoji, no hype.
- Do NOT invent specifics (exact comp figures, company names, perks) not supported by the details. If the company name is confidential or not provided, keep it anonymized in all fields.
- Every field must be present and non-empty. Base everything on the internal details given.
- Return ONLY the raw JSON object — no markdown fences, no preamble, no commentary.`;

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
  // (same cascade pattern as generate-linkedin-job-post).
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

  // Supabase types a joined relation as array|object depending on shape.
  const companyRaw = (job as any).company;
  const company = Array.isArray(companyRaw) ? companyRaw[0] : companyRaw;

  const companyName = (job as any).company_name || company?.name || "";
  const lines: string[] = [
    `Internal role title: ${(job as any).title || "(not specified)"}`,
    companyName ? `Company: ${companyName}` : "Company: (confidential / not specified)",
    (job as any).location ? `Internal location: ${(job as any).location}` : "",
    (job as any).compensation ? `Internal compensation: ${(job as any).compensation}` : "",
    company?.industry ? `Industry: ${company.industry}` : "",
    company?.size ? `Company size: ${company.size}` : "",
    company?.hq_location ? `Company HQ: ${company.hq_location}` : "",
    company?.description ? `About the company: ${String(company.description).slice(0, 800)}` : "",
    (job as any).description ? `Internal role description:\n${String((job as any).description).slice(0, 2500)}` : "",
    (job as any).additional_notes ? `Additional notes:\n${String((job as any).additional_notes).slice(0, 1000)}` : "",
  ].filter(Boolean);

  const userPrompt = `Produce the marketing JSON from these internal details:\n\n${lines.join("\n")}`;

  try {
    const { text, via } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      // OpenAI leads, Claude is the first fallback.
      order: ["openai", "claude", "gemini", "openrouter"],
      systemPrompt: SYSTEM_PROMPT,
      userContent: userPrompt,
      model: "claude-sonnet-4-6",
      maxTokens: 900,
      temperature: 0.6,
      jsonOutput: true,
    });

    let parsed: Record<string, unknown>;
    try {
      // Strip any stray code fences before parsing.
      const cleaned = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: "AI returned malformed JSON" });
    }

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const marketing = {
      marketing_title: str(parsed.marketing_title),
      marketing_type_of_firm: str(parsed.marketing_type_of_firm),
      marketing_job_location: str(parsed.marketing_job_location),
      marketing_job_compensation: str(parsed.marketing_job_compensation),
      marketing_job_description: str(parsed.marketing_job_description),
    };

    if (!Object.values(marketing).some(Boolean)) {
      return res.status(502).json({ error: "AI returned empty marketing fields" });
    }

    return res.status(200).json({ marketing, via });
  } catch (err: any) {
    console.error("generate-job-marketing error:", err?.message);
    return res.status(500).json({ error: `AI call failed: ${err?.message ?? "unknown"}` });
  }
}
