import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { callAIWithFallback } from "../src/lib/ai-fallback";

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
 *
 * Reply-chain markers often land inline (no leading newline), especially
 * when the body was HTML and we flattened it. Patterns are anchored on
 * distinctive tokens (weekday/month abbrev, "wrote:", "From:"/"Sent:" pair)
 * rather than newline placement.
 */
function trimToOriginal(text: string): string {
  let t = text;
  const cuts: RegExp[] = [
    // "On Fri, Mar 27, 2026 at 9:47 AM Jane Doe <…> wrote:"
    // "On Mon Mar 10 at 10:00 AM, Jane Doe wrote:"
    /\bOn (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^]{5,200}?wrote:[\s\S]*/i,
    // Outlook / many clients
    /-{2,} ?Original Message ?-{2,}[\s\S]*/i,
    /-{2,} ?Forwarded message ?-{2,}[\s\S]*/i,
    // Outlook "From: X\nSent: Y" header block (newline or inline)
    /\bFrom:\s+[^\n]{2,150}\s+Sent:\s[\s\S]*/,
    // Raw MIME cruft
    /\bX-MS-Exchange-[\s\S]*/,
    /\bContent-Type:\s+[\s\S]*/,
    /\bMIME-Version:\s+[\s\S]*/,
    // Calendly / scheduling boilerplate — not a signature
    /\bNeed to make changes to this event\?[\s\S]*/i,
    /\bPowered by Calendly[\s\S]*/i,
  ];
  for (const re of cuts) {
    const m = t.match(re);
    if (!m || m.index === undefined) continue;
    const trimmed = t.slice(0, m.index).trimEnd();
    // Only apply the trim if it leaves at least a few chars of real content —
    // otherwise the whole body was the quoted chain and we may as well keep it.
    if (trimmed.length >= 10) t = trimmed;
  }
  return t;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  // Gemini is the primary parser; OpenAI is the fallback. Pull both
  // from env first, then app_settings. Either-or is enough — the
  // helper handles a missing key gracefully.
  let geminiKey = process.env.GEMINI_API_KEY || "";
  let openaiKey = process.env.OPENAI_API_KEY || "";
  if (!geminiKey || !openaiKey) {
    const admin = createClient(supabaseUrl, serviceKey);
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
    return res.status(500).json({ error: "Email-signature parser: neither GEMINI_API_KEY nor OPENAI_API_KEY configured" });
  }

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
    const userPrompt = `Extract the SENDER's contact info from the email below. Return ONLY valid JSON, no markdown, no backticks. Omit any field you can't confidently fill.

Fields: first_name, last_name, email, phone, title, company_name, location, linkedin_url

Rules:
- Prefer the signature block at the bottom for title/company/phone/location.
- If the sender name from headers is given, trust it over names mentioned in the body.
- Never return email addresses that look like newsletters, noreply, or automated senders.

${hint ? hint + "\n\n" : ""}Email (cleaned, plaintext):
---
${signatureBlock}
---

JSON:`;

    const { text } = await callAIWithFallback({
      geminiKey: geminiKey || undefined,
      openaiKey: openaiKey || undefined,
      systemPrompt: "You extract contact info from email signatures and return JSON.",
      userContent: userPrompt,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 500,
      jsonOutput: true,
    });
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
