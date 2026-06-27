import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { callAIWithFallback, RESUME_PARSE_ORDER } from "./lib/ai-fallback.js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/format-resume-ai
 *
 * Formats a candidate's resume into the Emerald Recruiting Group house style and
 * returns a self-contained HTML document (inline CSS) that the client renders in
 * a preview and converts to a `<Name>_Emerald.pdf`. The AI controls the full
 * layout; the client injects the logo by replacing the `__EMERALD_LOGO_SRC__`
 * placeholder in the returned HTML.
 *
 * Uses the OpenAI-first cascade (OpenAI → Claude → Gemini → OpenRouter) per the
 * firm's preference ("openai, then claude, then gemini").
 *
 * Body:
 *  - resume_text      raw resume text (required)
 *  - name_mode        'all_contact' | 'name_only' | 'first_name'
 *  - display_name     resolved header name (e.g. "Jay" or "Marshall L. Duggs")
 *  - job_title, job_description   optional, to emphasise relevant experience
 *  - feedback         optional free-text revision request (the "modify" loop)
 *  - prior_html       optional previously-generated HTML to revise
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const {
      resume_text,
      name_mode = "all_contact",
      display_name,
      job_title,
      job_description,
      feedback,
      prior_html,
    } = req.body ?? {};

    if (!resume_text && !prior_html) {
      return res.status(400).json({ error: "Missing required field: resume_text" });
    }

    let anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.anthropic_api_key || "";
    let openaiKey = process.env.OPENAI_API_KEY || "";
    let geminiKey = process.env.GEMINI_API_KEY || "";
    let openRouterKey = process.env.OPENROUTER_API_KEY || "";
    if (!anthropicKey || !openaiKey || !geminiKey || !openRouterKey) {
      const supaUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
      const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supaUrl && svc) {
        const admin = createClient(supaUrl, svc);
        const { data } = await admin
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
    }
    if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
      return res.status(500).json({ error: "Resume formatter: no ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY configured" });
    }

    const nameRule =
      name_mode === "first_name"
        ? `Header name: use ONLY the candidate's first name${display_name ? ` ("${display_name}")` : ""}. Remove ALL contact information (phone, email, address, LinkedIn, websites, GitHub).`
        : name_mode === "name_only"
          ? `Header name: keep the candidate's full name${display_name ? ` ("${display_name}")` : ""}. Remove ALL contact information (phone, email, address, LinkedIn, websites, GitHub).`
          : `Header name: keep the candidate's full name${display_name ? ` ("${display_name}")` : ""}. Keep their contact information (phone, email, location, LinkedIn) directly under the name.`;

    const jobContext = job_title
      ? `\n\nTarget role (emphasise the candidate's genuinely relevant experience for it, but DO NOT fabricate anything): ${job_title}${job_description ? ` — ${String(job_description).slice(0, 1200)}` : ""}`
      : "";

    const systemPrompt = `You are a formatting engine for The Emerald Recruiting Group. You convert a candidate's resume into a single, self-contained HTML document (inline CSS only — no <style> tag dependencies on external sheets, no <script>) that prints cleanly to US Letter and is emailed to clients.

EMERALD RESUME FORMATTING RULES:
- Clean, professional, easy to read. Readable font sizes (≈10–11pt body, larger name). Do NOT shrink the font just to fit fewer pages. Prioritise readability over one-page compression. Consistent margins.
- Place the Emerald logo in the TOP RIGHT corner. Use exactly this <img> with the placeholder src token (the host app replaces it): <img src="__EMERALD_LOGO_SRC__" alt="Emerald Recruiting Group" style="position:absolute;top:0;right:0;width:96px;height:auto;" />. Wrap the whole document body in a container with position:relative so the logo anchors top-right, and reserve right padding so the name does not overlap it.
- Brand colors: dark green #1e3d2e for section headers and the name, gold #b4963c as a subtle accent (e.g. the rule under section headers). Body text near-black #212121.
- Company names and job titles start FLUSH with the left margin — never indented away from the margin.
- Dates go on the SAME ROW as the company name or job title, right-aligned in a fixed right-hand date column. Never stack dates on their own line or under the company/title. Use a two-column flex/table row: left = company or title, right = right-aligned dates.
- One role at a company: Company Name, Location in BOLD left-aligned with company dates BOLD right-aligned on the same row; Job Title in ITALIC left-aligned with role dates (if different) ITALIC right-aligned on the same row; bullets directly under the role.
- Multiple roles at the same company: list the company ONCE with overarching company dates (bold, same-row right-aligned); then each role underneath as italic title left + italic role dates right on the same row, bullets under each role. Do not bold job titles.
- Use bullet points (<ul><li>) for all experience detail.
- Clean up grammar, punctuation, spacing. Do NOT invent information. Do NOT add achievements, responsibilities, technologies, locations, compensation, visa status, or qualifications not present in the resume. Preserve the candidate's original substance. Remove only obvious duplicate bullets.
- ${nameRule}
- If contact info is removed, do NOT leave blank lines or awkward gaps where it used to be.

OUTPUT: Return ONLY the HTML document, starting with <!doctype html> or <div>. No markdown fences, no commentary before or after.`;

    const userPrompt = prior_html
      ? `Revise the following formatted resume HTML according to this instruction, keeping all the Emerald formatting rules intact and not fabricating anything:

INSTRUCTION: ${feedback || "Improve clarity and formatting."}

CURRENT HTML:
${prior_html}`
      : `Format this resume into Emerald-styled HTML following all the rules.${jobContext}${feedback ? `\n\nAdditional instruction: ${feedback}` : ""}

RESUME TEXT:
${resume_text}`;

    const { text } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      order: RESUME_PARSE_ORDER,
      systemPrompt,
      userContent: userPrompt,
      maxTokens: 4096,
      temperature: 0,
    });

    // Strip any accidental markdown code fences.
    let html = text.trim();
    const fence = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (fence) html = fence[1].trim();

    if (!/<[a-z!]/i.test(html)) {
      throw new Error("Formatter did not return HTML");
    }

    return res.status(200).json({ html });
  } catch (err: any) {
    console.error("format-resume-ai error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
