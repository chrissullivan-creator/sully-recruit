import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/parse-email-signature
 *
 * Uses Claude to extract structured contact info from an email signature.
 * Strips HTML + boilerplate, then asks Claude to return JSON fields.
 *
 * Body: { body: string, sender_name?: string, sender_address?: string }
 * Auth: Supabase JWT
 */

/**
 * Convert HTML to plaintext-ish, preserving line breaks where meaningful.
 * Good enough for signature parsing; not a full HTML → text converter.
 */
function htmlToText(input: string): string {
  return input
    // Drop script/style blocks entirely
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    // Turn <br>, <p>, <div>, <tr>, <li> into newlines before stripping
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode the handful of entities that show up in signatures
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace per-line but keep newlines
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Drop quoted reply chains and MIME / email-header cruft that confuses the
 * parser — we want the part of the message the *sender* actually wrote.
 */
function trimToOriginal(text: string): string {
  let t = text;
  const cuts = [
    /\n\s*On .{10,120} wrote:\s*\n[\s\S]*/,
    /\n\s*-{3,} ?Original Message ?-{3,}[\s\S]*/i,
    /\n\s*-{3,} ?Forwarded message ?-{3,}[\s\S]*/i,
    /\n\s*From: .+\nSent: [\s\S]*/,
    /\n\s*X-MS-Exchange-[\s\S]*/,
    /\n\s*Content-Type: [\s\S]*/,
    /\n\s*MIME-Version: [\s\S]*/,
  ];
  for (const re of cuts) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index > 40) {
      t = t.slice(0, m.index).trimEnd();
    }
  }
  return t;
}

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

  const { body, sender_name, sender_address } = req.body || {};
  if (!body || typeof body !== "string" || body.trim().length < 10) {
    return res.status(200).json({});
  }

  // Normalize: strip HTML, drop reply chains / MIME headers, collapse whitespace.
  const plain = trimToOriginal(htmlToText(body));
  if (plain.length < 10) return res.status(200).json({});

  // Signatures can land anywhere in a threaded email, but for the *original*
  // message (after trimming replies) the signature is at the end. Give Claude
  // the last ~2500 chars — enough to catch multi-line sigs without blowing
  // context on body prose.
  const signatureBlock = plain.slice(-2500);

  const hint = [
    sender_name ? `Sender name (from email headers): ${sender_name}` : "",
    sender_address ? `Sender address (from email headers): ${sender_address}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `Extract the SENDER's contact info from the email below. Return ONLY valid JSON, no markdown, no backticks. Omit any field you can't confidently fill.

Fields: first_name, last_name, email, phone, title, company_name, location, linkedin_url

Rules:
- Prefer the signature block at the bottom for title/company/phone/location.
- If the sender name from headers is given, trust it over names mentioned in the body.
- Never return email addresses that look like newsletters, noreply, or automated senders.

${hint ? hint + "\n\n" : ""}Email (cleaned, plaintext):
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
