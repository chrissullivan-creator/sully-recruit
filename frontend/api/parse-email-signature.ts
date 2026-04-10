import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/parse-email-signature
 *
 * Uses Claude Sonnet to extract structured contact info from an email signature.
 * Takes the raw email body, extracts the last ~1500 chars (where the sig lives),
 * and returns parsed JSON fields.
 *
 * Body: { body: string }
 * Auth: Supabase JWT
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "Server misconfigured: missing ANTHROPIC_API_KEY" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  // Auth
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { body } = req.body || {};
  if (!body || body.trim().length < 10) {
    return res.status(200).json({});
  }

  // Extract the last ~1500 chars — signature lives at the bottom
  const signatureBlock = body.slice(-1500);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Extract contact info from this email signature/body. Return ONLY valid JSON, no markdown, no backticks. If a field is not found, omit it entirely.

Fields: first_name, last_name, email, phone, title, company_name, location, linkedin_url

Email body (focus on signature at the end):
---
${signatureBlock}
---

JSON:`,
          },
        ],
      }),
    });

    if (!resp.ok) {
      console.error("Claude API error:", await resp.text());
      return res.status(200).json({});
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(200).json({});

    const parsed = JSON.parse(jsonMatch[0]);

    // Sanitize — only return expected fields
    const allowed = [
      "first_name", "last_name", "email", "phone",
      "title", "company_name", "location", "linkedin_url",
    ];
    const result: Record<string, string> = {};
    for (const key of allowed) {
      if (parsed[key] && typeof parsed[key] === "string") {
        result[key] = parsed[key].trim();
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("Signature parse failed:", err);
    return res.status(200).json({});
  }
}
