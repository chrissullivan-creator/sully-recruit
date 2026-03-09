import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function makeSupabase(authHeader: string | null) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    authHeader ? { global: { headers: { Authorization: authHeader } } } : {}
  );
}

async function getUserOpenAIConfig(authHeader: string | null) {
  if (!authHeader) return null;
  try {
    const { data } = await makeSupabase(authHeader)
      .from("user_integrations")
      .select("config, is_active")
      .eq("integration_type", "openai")
      .eq("is_active", true)
      .maybeSingle();
    if (data?.config?.api_key) return data.config as { api_key: string; model?: string };
  } catch { /* ignore */ }
  return null;
}

async function fetchCRMContext(authHeader: string | null): Promise<string> {
  if (!authHeader) return "";
  const sb = makeSupabase(authHeader);

  try {
    const [candidatesRes, prospectsRes, jobsRes, sequencesRes, contactsRes] = await Promise.all([
      sb.from("candidates").select("full_name, current_title, current_company, email, status, location").order("created_at", { ascending: false }).limit(30),
      sb.from("prospects").select("full_name, current_title, current_company, email, status, location").order("created_at", { ascending: false }).limit(30),
      sb.from("jobs").select("id, title, company_name, status, location, compensation, description").neq("status", "closed").order("created_at", { ascending: false }).limit(20),
      sb.from("sequences").select("id, name, channel, status, description, job_id, sequence_steps(step_order, step_type, channel, subject, body, delay_days)").order("created_at", { ascending: false }).limit(15),
      sb.from("contacts").select("full_name, title, email").order("created_at", { ascending: false }).limit(20),
    ]);

    const sections: string[] = [];
    const jobs = jobsRes.data ?? [];
    const jobMap = new Map(jobs.map((j: any) => [j.id, j]));

    const candidates = candidatesRes.data ?? [];
    if (candidates.length > 0) {
      sections.push(`CANDIDATES IN PIPELINE (${candidates.length}):\n` + candidates.map(c =>
        `- ${c.full_name || "Unknown"}${c.current_title ? `, ${c.current_title}` : ""}${c.current_company ? ` @ ${c.current_company}` : ""}${c.location ? ` (${c.location})` : ""} — Status: ${c.status}`
      ).join("\n"));
    }

    const prospects = prospectsRes.data ?? [];
    if (prospects.length > 0) {
      sections.push(`PROSPECTS (${prospects.length}):\n` + prospects.map(p =>
        `- ${p.full_name || "Unknown"}${p.current_title ? `, ${p.current_title}` : ""}${p.current_company ? ` @ ${p.current_company}` : ""} — Status: ${p.status}`
      ).join("\n"));
    }

    if (jobs.length > 0) {
      sections.push(`OPEN JOBS (${jobs.length}):\n` + jobs.map((j: any) =>
        `- [${j.id.slice(0,8)}] ${j.title}${j.company_name ? ` @ ${j.company_name}` : ""}${j.location ? ` (${j.location})` : ""}${j.compensation ? ` — ${j.compensation}` : ""} [${j.status}]${j.description ? `\n  Description: ${j.description.slice(0, 300)}` : ""}`
      ).join("\n"));
    }

    const sequences = sequencesRes.data ?? [];
    if (sequences.length > 0) {
      sections.push(`OUTREACH SEQUENCES (${sequences.length}):\n` + sequences.map((s: any) => {
        const taggedJob = s.job_id ? jobMap.get(s.job_id) : null;
        const stepsArr = ((s.sequence_steps as any[]) ?? []).sort((a: any, b: any) => a.step_order - b.step_order);
        let entry = `- "${s.name}" — Channel: ${s.channel}, Status: ${s.status}${s.description ? `, ${s.description}` : ""}`;
        if (taggedJob) {
          entry += `\n  Tagged Job: ${taggedJob.title}${taggedJob.company_name ? ` @ ${taggedJob.company_name}` : ""}${taggedJob.location ? ` (${taggedJob.location})` : ""}${taggedJob.compensation ? `, ${taggedJob.compensation}` : ""}`;
        }
        if (stepsArr.length > 0) {
          entry += `\n  Steps (${stepsArr.length}):`;
          stepsArr.forEach((st: any) => {
            const stepChannel = st.step_type || st.channel || "unknown";
            entry += `\n    Step ${st.step_order}: [${stepChannel}]${st.delay_days > 0 ? ` wait ${st.delay_days}d` : ""}${st.subject ? ` Subject: "${st.subject}"` : ""}`;
            if (st.body) entry += `\n      Content: ${st.body.slice(0, 500)}`;
          });
        }
        return entry;
      }).join("\n\n"));
    }

    const contacts = contactsRes.data ?? [];
    if (contacts.length > 0) {
      sections.push(`CONTACTS (${contacts.length}):\n` + contacts.map(c =>
        `- ${c.full_name || "Unknown"}${c.title ? `, ${c.title}` : ""}${c.email ? ` <${c.email}>` : ""}`
      ).join("\n"));
    }

    return sections.length > 0 ? sections.join("\n\n") : "No data found in the CRM yet.";
  } catch (e) {
    console.error("CRM context fetch error:", e);
    return "";
  }
}

async function searchResumes(authHeader: string | null) {
  if (!authHeader) return [];
  try {
    const { data: resumes } = await makeSupabase(authHeader)
      .from("candidate_resumes")
      .select("file_name, raw_text, ai_summary, candidates(full_name, current_title, current_company, email)")
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

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let systemPrompt: string;

    if (mode === "resume_search") {
      const resumes = await searchResumes(authHeader);
      if (resumes.length > 0) {
        const resumeContext = resumes.map((r: any, i: number) => {
          const c = r.candidates;
          const name = c?.full_name || "Unknown";
          const title = c?.current_title || "";
          const company = c?.current_company || "";
          const text = (r.raw_text || "").slice(0, 2000);
          return `--- Candidate ${i + 1}: ${name}${title ? ` (${title}` : ""}${company ? ` at ${company})` : title ? ")" : ""} ---\n${text}`;
        }).join("\n\n");

        systemPrompt = `You are Joe, an expert recruiting assistant inside Emerald Recruit. You have access to ${resumes.length} candidate resumes.

When searching for candidates, identify matches and explain:
1. Name, title, company
2. Why they match (skills, experience, background)
3. Fit level: Strong Match / Good Match / Partial Match

Be concise and direct. If no matches, say so honestly. Never mention databases, Supabase, IDs, or technical systems.

RESUME DATABASE:\n${resumeContext}`;
      } else {
        systemPrompt = `You are Joe, a recruiting assistant. No resumes with parsed text are available yet — let the user know they need to upload resumes to candidates first.`;
      }
    } else {
      // General mode — always inject live CRM context
      const crmContext = await fetchCRMContext(authHeader);

      systemPrompt = `You are Joe, a sharp recruiting assistant embedded in Emerald Recruit CRM. You help recruiters work faster and smarter.

You can:
- Answer questions about people, jobs, and sequences in the CRM
- Draft outreach messages (LinkedIn, email, SMS) with a direct, professional tone
- Suggest next steps for specific candidates or roles
- Advise on recruiting strategy and best practices

Rules:
- Be concise, specific, and actionable — no fluff
- NEVER mention Supabase, databases, APIs, UUIDs, table names, technical systems, or internal IDs
- When drafting messages, use {{first_name}}, {{company}}, {{title}} as personalization placeholders
- Refer to data naturally, as if you know the team's pipeline

CURRENT CRM DATA:
${crmContext}`;
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
          JSON.stringify({ error: "Invalid API key. Check your key in Settings." }),
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
