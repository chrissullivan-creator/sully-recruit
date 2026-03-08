import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const { campaignName, campaignChannel, campaignDescription } = await req.json();

    const systemPrompt = `You are a recruiting outreach expert. Generate a multi-step outreach campaign sequence for recruiting.

Return a JSON array of steps. Each step must have:
- channel: one of "email", "linkedin_message", "linkedin_connection", "linkedin_recruiter", "sales_nav", "phone", "sms"
- subject: email subject line (only for email steps, null otherwise)
- content: the message body text
- delayDays: number of days to wait before this step (0 for first step)

Generate 4-6 steps. Mix channels appropriately. Keep messages concise, professional, and personalized with {{first_name}}, {{company}}, {{title}} placeholders.

Respond with ONLY the JSON array, no markdown formatting.`;

    const userPrompt = `Create an outreach sequence for: "${campaignName}"
Primary channel: ${campaignChannel}
${campaignDescription ? `Description: ${campaignDescription}` : ""}`;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      }
    );

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again shortly." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add funds in workspace settings." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "[]";

    // Parse JSON from content (strip markdown fences if present)
    let steps;
    try {
      const cleaned = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      steps = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse AI response:", content);
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
