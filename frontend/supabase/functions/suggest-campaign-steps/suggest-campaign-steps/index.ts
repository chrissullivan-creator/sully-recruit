import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??
  "";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("Anthropic API key not configured");

    const { campaignName, campaignChannel, campaignDescription } = await req.json();

    const systemPrompt = `You are Joe — the AI backbone of Sully Recruit, built for The Emerald Recruiting Group, a Wall Street staffing firm. Generate a multi-step outreach sequence for recruiting.

Return ONLY a raw JSON array — no markdown fences, no backticks, no preamble. Each step object must have:
- channel: one of "email", "linkedin_message", "linkedin_connection", "linkedin_recruiter", "sales_nav", "phone", "sms"
- subject: email subject line (only for email steps, null otherwise)
- content: the message body text
- delayDays: number of days to wait before this step (0 for first step)

Generate 4-6 steps. Mix channels appropriately. Keep messages concise, professional, and personalized with {{first_name}}, {{company}}, {{title}} placeholders. Wall Street tone — direct, no fluff.`;

    const userPrompt = `Create an outreach sequence for: "${campaignName}"
Primary channel: ${campaignChannel}
${campaignDescription ? `Description: ${campaignDescription}` : ""}`;

    const response = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Claude error:", response.status, text);
      throw new Error(`Claude request failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text ?? "[]";

    let steps;
    try {
      const cleaned = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      steps = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse Claude response:", content);
      steps = [];
    }

    return new Response(JSON.stringify({ steps }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("suggest-campaign-steps error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
