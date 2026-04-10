import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * POST /api/draft-sequence-message
 *
 * Asks Joe (Claude) to draft a sequence step message in Emerald voice.
 * Pulls context from the job, sequence objective, audience type, step number,
 * and channel to produce a message that fits the overall flow.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      channel,
      step_number,
      step_label,
      total_steps,
      audience_type,
      sequence_name,
      sequence_objective,
      sender_name,
      sender_title,
      job_title,
      job_company,
      job_description,
      previous_messages,
    } = req.body;

    if (!channel) {
      return res.status(400).json({ error: "Missing required field: channel" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    // Channel-specific guidance
    const CHANNEL_RULES: Record<string, string> = {
      linkedin_connection:
        "LinkedIn Connection Request — 300 character MAX, one punchy sentence. Mention their firm or role. No pitch, just a reason to connect.",
      linkedin_message:
        "LinkedIn Message (after connection accepted) — 3-5 sentences. Warm, specific, low-friction ask like a 15-minute call. Reference the role.",
      linkedin_inmail:
        "LinkedIn InMail — 4-7 sentences. Open with hook, establish credibility, name the opportunity clearly, close with soft ask.",
      email:
        "Email — 2-3 short paragraphs. Sharp opening line (no 'hope this finds you well'). Name the opportunity. Clear CTA. Professional but warm.",
      sms:
        "SMS — Under 160 characters. First name, context, ask. Be human. No links unless essential.",
    };

    const channelRule = CHANNEL_RULES[channel] || "Write a professional outreach message.";

    // Build the step context
    let stepContext = `This is step ${step_number}${total_steps ? ` of ${total_steps}` : ""} in the sequence.`;
    if (step_label) stepContext += ` The step is labeled "${step_label}".`;
    if (step_number && step_number > 1) {
      stepContext += ` The previous step(s) already reached out via other channels — this should feel like a follow-up, not the first touch.`;
    } else {
      stepContext += ` This is the FIRST touch — introduce yourself.`;
    }

    // Previous messages in this sequence (for voice continuity)
    let previousMessagesBlock = "";
    if (previous_messages && Array.isArray(previous_messages) && previous_messages.length > 0) {
      previousMessagesBlock = `\n\nPrevious messages already in this sequence (maintain voice consistency, don't repeat these):\n${previous_messages
        .map((m: any, i: number) => `[${i + 1}] ${m.channel}: ${m.body || "(empty)"}`)
        .join("\n")}`;
    }

    const jobBlock = job_title
      ? `\n\nJob Context:
- Title: ${job_title}
${job_company ? `- Company: ${job_company}` : ""}
${job_description ? `- Description: ${String(job_description).slice(0, 1500)}` : ""}`
      : "";

    const prompt = `You are Joe — a senior Wall Street recruiter at The Emerald Recruiting Group. Write a sequence step message in Emerald voice.

EMERALD VOICE:
- Confident but not arrogant. Warm without sycophantic.
- Direct — every sentence earns its place.
- Never open with "I hope this message finds you well" or any variant
- Never use: synergy, leverage (verb), circle back, touch base
- Lead with something specific to the person or role
- Name the opportunity clearly — no coyness
- Establish credibility fast (Emerald places at top Wall Street firms, 82% of placements stay 2+ years)
- Clear low-friction ask: a 15-minute call
- Human — like a colleague who respects their time

CHANNEL: ${channel}
CHANNEL RULES: ${channelRule}

SEQUENCE CONTEXT:
- Sequence name: ${sequence_name || "(untitled)"}
- Audience: ${audience_type || "candidates"}
- Objective: ${sequence_objective || "general outreach"}
- ${stepContext}${jobBlock}${previousMessagesBlock}

SENDER: ${sender_name || "Chris Sullivan"}${sender_title ? `, ${sender_title}` : ", President"} at The Emerald Recruiting Group

MERGE TAGS AVAILABLE (use them naturally):
{{first_name}} — the candidate/contact's first name
{{last_name}} — last name
{{company}} — their current company
{{title}} — their current title
{{job_name}} — the job title we're recruiting for (only if this sequence is tied to a job)
{{sender_name}} — your name (the recruiter sending)

IMPORTANT:
- Use merge tags in the body, DO NOT use placeholder brackets or "[NAME]"
- DO NOT include a greeting like "Hi {{first_name}}," in the body for SMS
- For LinkedIn Connection: one sentence, no sign-off
- For LinkedIn Message and InMail: include a friendly close like "Best," before sender
- For Email: write the body only, no "Subject:" line
- Return ONLY the message body as plain text — no JSON, no markdown, no preamble

Write the message now:`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error: ${errText}`);
    }

    const result = await response.json();
    const text = (result.content?.[0]?.text || "").trim();

    if (!text) {
      throw new Error("Joe returned an empty draft");
    }

    return res.status(200).json({ message: text });
  } catch (err: any) {
    console.error("draft-sequence-message error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
