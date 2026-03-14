import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-info, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function getUserOpenAIConfig(authHeader: string | null) {
  if (!authHeader) return null;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.1");
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

    const {
      candidateName,
      communications,
      notes,
      jobs,
      currentTitle,
      currentCompany,
      location,
    } = await req.json();

    const systemPrompt = `You are an expert recruiter specializing in candidate profiling. Generate a comprehensive one-paragraph executive summary of a candidate based on the provided information.

The summary should cover:
1. Communication style and responsiveness (eager/responsive/quiet/no-response pattern)
2. Compensation history and salary expectations from notes
3. Relocation flexibility and location preferences
4. Why they're looking to leave current role
5. Career progression and job move explanations
6. Visa/work authorization status
7. Career aspirations and next desired moves
8. Any relevant personality traits or interesting facts from notes

Write in a professional, concise recruiting tone. Keep it to 3-4 sentences maximum, packing maximum useful information for a recruiter.`;

    const userPrompt = `Candidate: ${candidateName}
Current Role: ${currentTitle || 'Unknown'} at ${currentCompany || 'Unknown'}
Location: ${location || 'Not specified'}

Communications:
${communications && communications.length > 0
      ? communications.map((c: any) => `- ${c.channel}: ${c.subject || c.last_message_preview || 'No content'} (${c.last_message_at || 'N/A'})`).join('\n')
      : '- No communications recorded'}

Job History:
${jobs && jobs.length > 0
      ? jobs.map((j: any) => `- ${j.title} at ${j.company} (Job Status: ${j.job_status})`).join('\n')
      : '- No jobs associated'}

Notes:
${notes && notes.length > 0
      ? notes.map((n: any) => `- ${n.note}`).join('\n\n')
      : '- No notes available'}

Generate a concise executive summary covering all relevant recruiting insights.`;

    let apiUrl: string;
    let apiKey: string;
    let model: string;
    let headers: Record<string, string>;

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
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
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
    const summary = data.choices?.[0]?.message?.content ?? "";

    return new Response(JSON.stringify({ summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-candidate-summary error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
