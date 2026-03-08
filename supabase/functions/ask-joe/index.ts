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

    const { messages } = await req.json();

    let apiUrl: string;
    let apiKey: string;
    let model: string;
    let headers: Record<string, string>;

    // Priority: user's personal key > OPENAI_API_KEY secret > Lovable AI fallback
    if (openaiConfig) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = openaiConfig.api_key;
      model = openaiConfig.model || "gpt-4o";
    } else if (Deno.env.get("OPENAI_API_KEY")) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = Deno.env.get("OPENAI_API_KEY")!;
      model = "gpt-4.1";
    } else {
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!LOVABLE_API_KEY) throw new Error("No AI API key configured.");
      apiUrl = "https://ai.gateway.lovable.dev/v1/chat/completions";
      apiKey = LOVABLE_API_KEY;
      model = "google/gemini-3-flash-preview";
    }
    headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are Joe, an AI recruiting assistant inside Emerald Recruit CRM. You help recruiters with:
- Drafting outreach messages (LinkedIn, email) with a sharp, professional tone
- Answering questions about recruiting best practices
- Suggesting next steps in the pipeline
Keep responses concise and actionable. Use {{first_name}}, {{company}}, {{title}} as placeholders when drafting messages.`,
          },
          ...messages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded, please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Add funds or check your OpenAI billing." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 401) {
        return new Response(
          JSON.stringify({ error: "Invalid OpenAI API key. Check your key in Settings." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const t = await response.text();
      console.error("AI error:", response.status, t);
      return new Response(
        JSON.stringify({ error: "AI request failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("ask-joe error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
