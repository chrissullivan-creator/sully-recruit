import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function getUserOpenAIConfig(authHeader: string | null) {
  if (!authHeader) return null;
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data } = await supabase
      .from("user_integrations")
      .select("config, is_active")
      .eq("integration_type", "openai")
      .eq("is_active", true)
      .maybeSingle();
    if (data?.config?.api_key) return data.config as { api_key: string; model?: string };
  } catch { /* ignore */ }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const openaiConfig = await getUserOpenAIConfig(authHeader);

    const { campaignName, campaignChannel, campaignDescription } = await req.json();

    const systemPrompt = `You are a recruiting outreach expert. Generate a multi-step outreach sequence for recruiting.

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

    let apiUrl: string;
    let apiKey: string;
    let model: string;
    let headers: Record<string, string>;

    if (openaiConfig) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = openaiConfig.api_key;
      model = openaiConfig.model || "gpt-4o";
      headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
    } else {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) throw new Error("No AI API key configured. Add your OpenAI key in Settings.");
      apiUrl = "https://ai.gateway.lovable.dev/v1/chat/completions";
      apiKey = LOVABLE_API_KEY;
      model = "google/gemini-3-flash-preview";
      headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Try again shortly." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 401) {
        return new Response(
          JSON.stringify({ error: "Invalid OpenAI API key. Check your key in Settings." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const text = await response.text();
      console.error("AI error:", response.status, text);
      throw new Error(`AI request failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "[]";

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
