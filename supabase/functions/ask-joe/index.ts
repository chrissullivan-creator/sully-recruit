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

async function searchResumes(authHeader: string | null, query: string) {
  if (!authHeader) return [];
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    // Fetch resumes with raw_text and join candidate info
    const { data: resumes } = await supabase
      .from("candidate_resumes")
      .select("id, file_name, raw_text, ai_summary, candidate_id, candidates(id, full_name, email, current_title, current_company)")
      .not("raw_text", "is", null)
      .limit(50);
    return resumes || [];
  } catch { return []; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const openaiConfig = await getUserOpenAIConfig(authHeader);

    const { messages, mode } = await req.json();

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

    let systemPrompt = `You are Joe, an AI recruiting assistant inside Emerald Recruit CRM. You help recruiters with:
- Drafting outreach messages (LinkedIn, email) with a sharp, professional tone
- Answering questions about recruiting best practices
- Suggesting next steps in the pipeline
Keep responses concise and actionable. Use {{first_name}}, {{company}}, {{title}} as placeholders when drafting messages.`;

    // Resume search mode: inject resume data into context
    if (mode === "resume_search") {
      const userQuery = messages[messages.length - 1]?.content || "";
      const resumes = await searchResumes(authHeader, userQuery);
      
      if (resumes.length > 0) {
        const resumeContext = resumes.map((r: any, i: number) => {
          const candidate = r.candidates;
          const name = candidate?.full_name || "Unknown";
          const title = candidate?.current_title || "";
          const company = candidate?.current_company || "";
          const text = (r.raw_text || "").slice(0, 2000); // Limit per resume
          return `--- Resume ${i + 1}: ${name} (${title} at ${company}) [candidate_id: ${candidate?.id}] ---\n${text}`;
        }).join("\n\n");

        systemPrompt = `You are Joe, an AI recruiting assistant specializing in resume search. You have access to ${resumes.length} candidate resumes below.

When the user asks to find candidates, search through these resumes and return:
1. The matching candidates with their names, titles, and companies
2. Why they match (relevant skills, experience)
3. A brief relevance score (Strong Match / Good Match / Partial Match)

Format results clearly. If no good matches, say so honestly.

RESUME DATABASE:
${resumeContext}`;
      } else {
        systemPrompt = `You are Joe, an AI recruiting assistant. The user asked to search resumes but no resumes with parsed text are available in the database. Let them know they need to upload resumes to candidates first before search will work.`;
      }
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
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
