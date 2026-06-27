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
 *  - feedback         optional cumulative correction notes (the "modify" loop) —
 *                     regenerated from source each time, not a diff on prior HTML
 */
export const maxDuration = 60;

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
    } = req.body ?? {};

    if (!resume_text) {
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
- Dates go on the SAME ROW as the company name or job title, right-aligned in a fixed right-hand date column. Never stack dates on their own line or under the company/title. Use a two-column row (e.g. flex with justify-content:space-between): left = company or title, right = right-aligned dates.
- Use bullet points (<ul><li>) for all experience detail.
- Clean up grammar, punctuation, spacing. Do NOT invent information. Do NOT add achievements, responsibilities, technologies, locations, compensation, visa status, or qualifications not present in the resume. Preserve the candidate's original substance. Remove only obvious duplicate bullets.
- ${nameRule}
- If contact info is removed, do NOT leave blank lines or awkward gaps where it used to be.

WORK EXPERIENCE — STRICT (read carefully, this is the most common mistake):
- GROUP BY COMPANY. If the candidate held MULTIPLE roles at the SAME company (consecutive titles/promotions), you MUST output that company HEADER EXACTLY ONCE: a single bold "Company Name, Location" on the left with the OVERARCHING date range on the right (earliest role start → latest role end), on one row. Then list EACH role beneath it: italic job title on the left with that role's OWN dates italic on the right (same row), with that role's bullets under it. NEVER repeat the company name as a separate block for a second role at the same company.
- One role at a company: bold "Company Name, Location" left + bold company dates right on one row; italic job title left + italic role dates right on one row (omit the role-date row if identical to the company dates); bullets under the role. Do not bold job titles.
- DATES: ALWAYS spell the month out in FULL with the year — "January 2020 – Present", "March 2018 – December 2019". NEVER abbreviate the month (no "Jan", "Feb", "Sept") and NEVER use numeric months (no "01/2020", no "2020-01"). Use an en dash "–" between start and end. Use "Present" for a current role.

WORKED EXAMPLE of a company with two roles (follow this structure exactly):
<div style="display:flex;justify-content:space-between;"><span style="font-weight:bold;">Goldman Sachs, New York, NY</span><span style="font-weight:bold;">June 2016 – Present</span></div>
<div style="display:flex;justify-content:space-between;"><span style="font-style:italic;">Vice President, Cross-Asset Quant Strats</span><span style="font-style:italic;">January 2020 – Present</span></div>
<ul><li>Bullet for the VP role.</li></ul>
<div style="display:flex;justify-content:space-between;"><span style="font-style:italic;">Associate, Quant Strats</span><span style="font-style:italic;">June 2016 – December 2019</span></div>
<ul><li>Bullet for the Associate role.</li></ul>

OUTPUT: Return ONLY the HTML document, starting with <!doctype html> or <div>. No markdown fences, no commentary before or after.`;

    // Always (re)generate from the source résumé. The "modify" loop passes the
    // recruiter's cumulative corrections in `feedback` rather than round-tripping
    // the prior HTML (which a model tends to echo back verbatim). Regenerating
    // from source reliably applies the requested changes.
    const userPrompt = `Format this resume into Emerald-styled HTML following ALL the rules above.${jobContext}${
      feedback
        ? `\n\nApply these corrections from the recruiter (they OVERRIDE the defaults — follow them exactly):\n${feedback}`
        : ""
    }

RESUME TEXT:
${resume_text}`;

    const { text } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      order: RESUME_PARSE_ORDER,
      fallbackModel: "gpt-5.4",
      systemPrompt,
      userContent: userPrompt,
      maxTokens: 12000,
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
