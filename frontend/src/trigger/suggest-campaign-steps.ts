import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

interface SuggestPayload {
  campaignName: string;
  campaignChannel: string;
  campaignDescription?: string;
}

/**
 * Generate AI-powered outreach sequence steps using Claude.
 *
 * Migrated from Supabase edge function for better retry/monitoring.
 * Called from CampaignBuilder UI via trigger API.
 */
export const suggestCampaignSteps = task({
  id: "suggest-campaign-steps",
  retry: { maxAttempts: 2 },
  maxDuration: 60,
  run: async (payload: SuggestPayload) => {
    const anthropicKey = await getAnthropicKey();

    const systemPrompt = `You are a recruiting outreach expert. Generate a multi-step outreach sequence for recruiting.

Return a JSON array of steps. Each step must have:
- channel: one of "email", "linkedin_message", "linkedin_connection", "linkedin_recruiter", "sales_nav", "phone", "sms"
- subject: email subject line (only for email steps, null otherwise)
- content: the message body text
- delayDays: number of days to wait before this step (0 for first step)

Generate 4-6 steps. Mix channels appropriately. Keep messages concise, professional, and personalized with {{first_name}}, {{company}}, {{title}} placeholders.

Respond with ONLY the JSON array, no markdown formatting.`;

    const userPrompt = `Create an outreach sequence for: "${payload.campaignName}"
Primary channel: ${payload.campaignChannel}
${payload.campaignDescription ? `Description: ${payload.campaignDescription}` : ""}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      logger.error("Claude API error", { status: resp.status, body: text });
      throw new Error(`Claude API error: ${resp.status}`);
    }

    const data = await resp.json();
    const content = data.content?.[0]?.text ?? "[]";

    let steps;
    try {
      const cleaned = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      steps = JSON.parse(cleaned);
    } catch {
      logger.error("Failed to parse Claude response", { content });
      steps = [];
    }

    logger.info("Generated campaign steps", { count: steps.length, campaign: payload.campaignName });
    return { steps };
  },
});
