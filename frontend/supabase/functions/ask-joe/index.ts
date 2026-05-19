// Ask Joe with tool use: streams a Claude → OpenAI → Gemini → OpenRouter
// cascade. Claude + OpenAI run with tool-use enabled (8 read-only tools
// over the recruiting CRM); Gemini + OpenRouter answer text-only without
// tools — they're only hit when the upstream providers fail, which is
// rare enough not to warrant per-provider tool schemas.
//
// Auth: requires a valid Supabase JWT (verify_jwt: true on deploy).
// SSE output:
//   data: {"content":"..."}              -- streaming text from the model
//   data: {"status":"Joe is searching..."} -- short ephemeral status line
//                                            shown while a tool runs
//
// Safety: tool calls are read-only; max 6 iterations per turn; 12s per
// tool; bodies are truncated before being injected back to the model so
// a runaway query can't drain the context window.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??
  "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const OPENAI_MODEL = "gpt-4o-mini";
const GEMINI_MODEL = "gemini-2.5-flash";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const VOYAGE_MODEL = "voyage-finance-2";
const TOP_K = 8;
const MAX_TOOL_ITERATIONS = 6;
const TOOL_TIMEOUT_MS = 12_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE_SYSTEM_PROMPT = `You are Joe — the AI backbone of Sully Recruit, built for The Emerald Recruiting Group, a Wall Street staffing firm. Sharp. Direct. Senior headhunter energy. Punchy, no walls of text.

Valid person statuses: new | reached_out | engaged. Never filter by back_of_resume or placed.

You have tools for searching the CRM. Use them whenever the user's question requires a fact about a specific person, job, communication, send-out, note, or company in the database — don't guess from memory. Chain tools when useful (e.g. search_people → get_person_detail → list_recent_communications).

When you reference a person or job, include their ID in parentheses so the recruiter can jump to their page. If a search returns no matches, say so plainly — don't invent people.`;

const TOOLS = [
  {
    name: "search_people",
    description:
      "Semantic + keyword search across candidates and clients. Combines vector search over resume_embeddings (candidates) and joe_says_embedding briefs (either type) with keyword fallback. Returns id, name, current title/company, status, similarity score, and a brief excerpt.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of who to find." },
        role: { type: "string", enum: ["candidate", "client"], description: "Restrict to candidates or clients only. Omit to search both." },
        status: { type: "string", enum: ["new", "reached_out", "engaged"], description: "Restrict to a specific status." },
        limit: { type: "number", description: "Max results (1-20). Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_person_detail",
    description: "Fetch the full joe_says brief plus the key profile fields for one person by id. Use after search_people to drill in.",
    input_schema: {
      type: "object",
      properties: { person_id: { type: "string", description: "uuid of the person" } },
      required: ["person_id"],
    },
  },
  {
    name: "list_recent_communications",
    description: "Return the most recent N conversations and calls for a person across all channels (email, LinkedIn, SMS, RingCentral call). Each row includes channel, subject/preview, direction, timestamp.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "uuid of the person" },
        limit: { type: "number", description: "Max rows (1-20). Default 10." },
      },
      required: ["person_id"],
    },
  },
  {
    name: "list_notes",
    description: "Return the most recent recruiter notes for a person. Each row: created_at + plain-text note.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "uuid of the person" },
        limit: { type: "number", description: "Max rows (1-20). Default 5." },
      },
      required: ["person_id"],
    },
  },
  {
    name: "list_send_outs",
    description: "Pipeline rows. Filter by person_id, job_id, or stage. Returns id, stage, candidate name, job title + company, created_at, last update.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string" },
        job_id: { type: "string" },
        stage: { type: "string", description: "e.g. pitched, submitted, interview, offer, placed, withdrawn" },
        limit: { type: "number", description: "Max rows. Default 20." },
      },
    },
  },
  {
    name: "list_jobs",
    description: "Search jobs by title/company. Returns id, title, company, location, status.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword over title/company." },
        status: { type: "string", description: "e.g. active, closed, lead, on_hold" },
        limit: { type: "number", description: "Max rows. Default 10." },
      },
    },
  },
  {
    name: "get_job_detail",
    description: "Fetch a single job's full details plus a summary of send-outs against it (count per stage).",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string", description: "uuid of the job" } },
      required: ["job_id"],
    },
  },
  {
    name: "search_companies",
    description: "Find companies by name. Returns id, name, domain, industry.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max rows. Default 10." },
      },
      required: ["query"],
    },
  },
];

const OPENAI_TOOLS = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function embedQuery(text: string): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: [text.slice(0, 8000)], input_type: "query" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

function statusFromToolCall(name: string, input: any): string {
  switch (name) {
    case "search_people": {
      const q = String(input?.query ?? "").slice(0, 60);
      const role = input?.role ? ` (${input.role}s)` : "";
      return `Joe is searching for ${q}${role}…`;
    }
    case "get_person_detail": return "Joe is pulling the brief…";
    case "list_recent_communications": return "Joe is checking recent messages…";
    case "list_notes": return "Joe is reading recruiter notes…";
    case "list_send_outs": return "Joe is reviewing the pipeline…";
    case "list_jobs": return "Joe is searching jobs…";
    case "get_job_detail": return "Joe is pulling the job…";
    case "search_companies": return "Joe is searching companies…";
    default: return `Joe is running ${name}…`;
  }
}

// ─── Tool implementations ────────────────────────────────────────────────

async function toolSearchPeople(supabase: any, input: any): Promise<string> {
  const query = String(input?.query ?? "").slice(0, 500);
  const role = input?.role === "candidate" || input?.role === "client" ? input.role : null;
  const status = typeof input?.status === "string" ? input.status : null;
  const limit = Math.min(Math.max(Number(input?.limit) || TOP_K, 1), 20);

  const embedding = await embedQuery(query);
  const idScore = new Map<string, { score: number; via: string; excerpt?: string }>();

  if (embedding && (!role || role === "candidate")) {
    const { data } = await supabase.rpc("match_resume_embeddings", {
      query_embedding: embedding,
      match_count: limit * 2,
      min_similarity: 0.3,
    });
    for (const r of (data as any[]) ?? []) {
      if (!r.candidate_id) continue;
      const prev = idScore.get(r.candidate_id);
      if (!prev || prev.score < r.similarity) {
        idScore.set(r.candidate_id, { score: r.similarity, via: "resume" });
      }
    }
  }

  if (embedding) {
    const { data } = await supabase.rpc("match_people_joe_says", {
      query_embedding: embedding,
      match_count: limit * 2,
      min_similarity: 0.3,
      role_filter: role,
    });
    for (const r of (data as any[]) ?? []) {
      if (!r.person_id) continue;
      const prev = idScore.get(r.person_id);
      const sim = Number(r.similarity ?? 0);
      const score = sim + 0.02; // bias brief matches slightly above resume matches
      if (!prev || prev.score < score) {
        idScore.set(r.person_id, { score, via: "brief", excerpt: r.joe_says_excerpt });
      }
    }
  }

  const keywords = query.split(/\s+/).filter((k) => k.length >= 3).slice(0, 4);
  if (keywords.length) {
    const orFilter = keywords
      .map((k) => `full_name.ilike.%${k}%,current_title.ilike.%${k}%,current_company.ilike.%${k}%`)
      .join(",");
    let q = supabase.from("candidates").select("id").or(orFilter);
    if (role) q = q.contains("roles", [role]);
    if (status) q = q.eq("status", status);
    q = q.limit(limit * 2);
    const { data } = await q;
    for (const r of (data as any[]) ?? []) {
      if (!idScore.has(r.id)) idScore.set(r.id, { score: 0.25, via: "keyword" });
    }
  }

  if (idScore.size === 0) return JSON.stringify({ results: [], note: "no matches" });

  const ids = [...idScore.keys()].slice(0, limit * 2);
  let q = supabase
    .from("candidates")
    .select(
      "id, full_name, current_title, current_company, location, status, primary_email, mobile_phone, linkedin_url, last_contacted_at, last_responded_at, roles",
    )
    .in("id", ids);
  if (role) q = q.contains("roles", [role]);
  if (status) q = q.eq("status", status);
  const { data: rows } = await q;

  const results = ((rows as any[]) ?? [])
    .map((r) => {
      const meta = idScore.get(r.id);
      return {
        id: r.id,
        name: r.full_name,
        title: r.current_title,
        company: r.current_company,
        location: r.location,
        status: r.status,
        email: r.primary_email ?? null,
        phone: r.mobile_phone ?? null,
        linkedin_url: r.linkedin_url ?? null,
        roles: r.roles ?? [],
        last_contacted_at: r.last_contacted_at ?? null,
        last_responded_at: r.last_responded_at ?? null,
        match_score: meta ? Number(meta.score.toFixed(3)) : null,
        match_via: meta?.via ?? "keyword",
        excerpt: meta?.excerpt ?? null,
      };
    })
    .sort((a: any, b: any) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, limit);

  return JSON.stringify({ results });
}

async function toolGetPersonDetail(supabase: any, input: any): Promise<string> {
  const personId = String(input?.person_id ?? "").trim();
  if (!personId) return JSON.stringify({ error: "person_id required" });
  const { data, error } = await supabase
    .from("candidates")
    .select(
      "id, full_name, current_title, current_company, location, status, joe_says, joe_says_updated_at, primary_email, personal_email, work_email, mobile_phone, phone, linkedin_url, last_contacted_at, last_responded_at, roles, current_base_comp, target_base_comp, current_total_comp, target_total_comp, visa_status, notice_period, target_locations, where_interviewed, where_submitted",
    )
    .eq("id", personId)
    .maybeSingle();
  if (error || !data) return JSON.stringify({ error: error?.message ?? "not_found" });
  const d: any = data;
  if (typeof d.joe_says === "string") d.joe_says = d.joe_says.slice(0, 4000);
  return JSON.stringify(d);
}

async function toolListRecentCommunications(supabase: any, input: any): Promise<string> {
  const personId = String(input?.person_id ?? "").trim();
  if (!personId) return JSON.stringify({ error: "person_id required" });
  const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 20);
  const [convRes, callRes] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, channel, subject, last_message_preview, last_message_at, last_inbound_at")
      .or(`candidate_id.eq.${personId},contact_id.eq.${personId}`)
      .order("last_message_at", { ascending: false })
      .limit(limit),
    supabase
      .from("call_logs")
      .select("id, direction, started_at, duration_seconds, summary")
      .or(`candidate_id.eq.${personId},contact_id.eq.${personId}`)
      .order("started_at", { ascending: false })
      .limit(Math.min(limit, 10)),
  ]);
  const conversations = ((convRes.data as any[]) ?? []).map((c) => ({
    id: c.id,
    type: "conversation",
    channel: c.channel,
    subject: c.subject,
    preview: (c.last_message_preview ?? "").slice(0, 200),
    last_message_at: c.last_message_at,
    last_inbound_at: c.last_inbound_at,
  }));
  const calls = ((callRes.data as any[]) ?? []).map((c) => ({
    id: c.id,
    type: "call",
    direction: c.direction,
    started_at: c.started_at,
    duration_seconds: c.duration_seconds,
    summary: (c.summary ?? "").slice(0, 400),
  }));
  const merged = [...conversations, ...calls]
    .sort((a: any, b: any) => {
      const ta = new Date(a.last_message_at ?? a.started_at ?? 0).getTime();
      const tb = new Date(b.last_message_at ?? b.started_at ?? 0).getTime();
      return tb - ta;
    })
    .slice(0, limit);
  return JSON.stringify({ items: merged });
}

async function toolListNotes(supabase: any, input: any): Promise<string> {
  const personId = String(input?.person_id ?? "").trim();
  if (!personId) return JSON.stringify({ error: "person_id required" });
  const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), 20);
  const { data, error } = await supabase
    .from("notes")
    .select("note, created_at, entity_type")
    .eq("entity_id", personId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return JSON.stringify({ error: error.message });
  const items = ((data as any[]) ?? []).map((n) => ({
    created_at: n.created_at,
    entity_type: n.entity_type,
    note: String(n.note ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600),
  }));
  return JSON.stringify({ items });
}

async function toolListSendOuts(supabase: any, input: any): Promise<string> {
  const limit = Math.min(Math.max(Number(input?.limit) || 20, 1), 50);
  let q = supabase
    .from("send_outs")
    .select("id, stage, created_at, updated_at, candidate_id, job_id, jobs(title, company_name), candidate:people!candidate_id(full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (input?.person_id) q = q.eq("candidate_id", input.person_id);
  if (input?.job_id) q = q.eq("job_id", input.job_id);
  if (input?.stage) q = q.eq("stage", input.stage);
  const { data, error } = await q;
  if (error) return JSON.stringify({ error: error.message });
  const items = ((data as any[]) ?? []).map((s) => ({
    id: s.id,
    stage: s.stage,
    candidate_id: s.candidate_id,
    candidate_name: (s.candidate as any)?.full_name ?? null,
    job_id: s.job_id,
    job_title: (s.jobs as any)?.title ?? null,
    job_company: (s.jobs as any)?.company_name ?? null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));
  return JSON.stringify({ items });
}

async function toolListJobs(supabase: any, input: any): Promise<string> {
  const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 25);
  let q = supabase
    .from("jobs")
    .select("id, title, company_name, location, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (input?.query) {
    const keywords = String(input.query).split(/\s+/).filter((k: string) => k.length >= 3).slice(0, 3);
    if (keywords.length) {
      const orFilter = keywords.map((k: string) => `title.ilike.%${k}%,company_name.ilike.%${k}%`).join(",");
      q = q.or(orFilter);
    }
  }
  if (input?.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ items: data ?? [] });
}

async function toolGetJobDetail(supabase: any, input: any): Promise<string> {
  const jobId = String(input?.job_id ?? "").trim();
  if (!jobId) return JSON.stringify({ error: "job_id required" });
  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, title, company_name, location, status, salary_range, description, created_at, updated_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error || !job) return JSON.stringify({ error: error?.message ?? "not_found" });
  const d: any = job;
  if (typeof d.description === "string") d.description = d.description.slice(0, 2500);
  const { data: stages } = await supabase.from("send_outs").select("stage").eq("job_id", jobId);
  const stageCounts: Record<string, number> = {};
  for (const s of (stages as any[]) ?? []) {
    const k = s.stage ?? "unknown";
    stageCounts[k] = (stageCounts[k] ?? 0) + 1;
  }
  return JSON.stringify({ job: d, send_outs_by_stage: stageCounts });
}

async function toolSearchCompanies(supabase: any, input: any): Promise<string> {
  const q = String(input?.query ?? "").trim();
  if (!q) return JSON.stringify({ error: "query required" });
  const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 25);
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, domain, industry")
    .ilike("name", `%${q}%`)
    .limit(limit);
  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify({ items: data ?? [] });
}

async function runTool(supabase: any, name: string, input: any): Promise<string> {
  const exec = async (): Promise<string> => {
    switch (name) {
      case "search_people": return await toolSearchPeople(supabase, input);
      case "get_person_detail": return await toolGetPersonDetail(supabase, input);
      case "list_recent_communications": return await toolListRecentCommunications(supabase, input);
      case "list_notes": return await toolListNotes(supabase, input);
      case "list_send_outs": return await toolListSendOuts(supabase, input);
      case "list_jobs": return await toolListJobs(supabase, input);
      case "get_job_detail": return await toolGetJobDetail(supabase, input);
      case "search_companies": return await toolSearchCompanies(supabase, input);
      default: return JSON.stringify({ error: `unknown tool ${name}` });
    }
  };
  try {
    const result = await Promise.race<string>([
      exec(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("tool_timeout")), TOOL_TIMEOUT_MS)),
    ]);
    return String(result).slice(0, 20_000);
  } catch (err: any) {
    return JSON.stringify({ error: err?.message ?? "tool_failed" });
  }
}

// ─── Anthropic streaming with tool-use loop ──────────────────────────────

const FALLBACK_REGEX =
  /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key|overloaded|quota|exhausted|unavailable|503|500/i;
function isFallbackable(status: number, body: string): boolean {
  if (status >= 500) return true;
  if (status === 429 || status === 401 || status === 403) return true;
  return FALLBACK_REGEX.test(body || "");
}

type StreamResult = { ok: true } | { ok: false; status: number; body: string; fallbackable: boolean };

async function streamAnthropicWithTools(
  supabase: any,
  systemPrompt: string,
  initialMessages: any[],
  send: (text: string) => void,
  status: (s: string) => void,
): Promise<StreamResult> {
  const messages: any[] = initialMessages.map((m) => ({ role: m.role, content: m.content }));

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        stream: true,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      }),
    });
    if (!resp.ok || !resp.body) {
      const body = resp.body ? await resp.text() : "";
      return { ok: false, status: resp.status, body, fallbackable: isFallbackable(resp.status, body) };
    }

    const blocks: any[] = [];
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopReason: string | null = null;

    const handleLine = (rawLine: string) => {
      let line = rawLine;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) return;
      const jsonStr = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      let evt: any;
      try { evt = JSON.parse(jsonStr); } catch { return; }
      const idx = evt.index ?? 0;
      switch (evt.type) {
        case "content_block_start": {
          const cb = evt.content_block;
          if (cb?.type === "text") blocks[idx] = { type: "text", text: "" };
          else if (cb?.type === "tool_use") blocks[idx] = { type: "tool_use", id: cb.id, name: cb.name, input_json: "" };
          break;
        }
        case "content_block_delta": {
          const d = evt.delta;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            const b = blocks[idx];
            if (b?.type === "text") {
              b.text += d.text;
              send(d.text);
            }
          } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
            const b = blocks[idx];
            if (b?.type === "tool_use") b.input_json += d.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          break;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer.length > 0) handleLine(buffer);

    const toolUses = blocks.filter((b) => b?.type === "tool_use");
    if (toolUses.length === 0 || stopReason !== "tool_use") return { ok: true };

    const assistantContent = blocks
      .map((b) => {
        if (!b) return null;
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "tool_use") {
          let parsedInput: any = {};
          try { parsedInput = JSON.parse(b.input_json || "{}"); } catch { /* empty */ }
          return { type: "tool_use", id: b.id, name: b.name, input: parsedInput };
        }
        return null;
      })
      .filter(Boolean);
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: any[] = [];
    for (const tu of toolUses) {
      let parsedInput: any = {};
      try { parsedInput = JSON.parse(tu.input_json || "{}"); } catch { /* empty */ }
      status(statusFromToolCall(tu.name, parsedInput));
      const result = await runTool(supabase, tu.name, parsedInput);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  send("\n\n_(Joe stopped iterating after several tool calls — try a more specific question.)_");
  return { ok: true };
}

// ─── OpenAI streaming with tool-call loop ────────────────────────────────

function flattenMessage(m: any): { role: string; content: string } {
  return {
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((b: any) => (typeof b === "string" ? b : (b?.text ?? ""))).join("\n")
      : m.content,
  };
}

async function streamOpenAIWithTools(
  supabase: any,
  systemPrompt: string,
  initialMessages: any[],
  send: (text: string) => void,
  status: (s: string) => void,
): Promise<StreamResult> {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...initialMessages.map(flattenMessage),
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, stream: true, tools: OPENAI_TOOLS, messages }),
    });
    if (!resp.ok || !resp.body) {
      const body = resp.body ? await resp.text() : "";
      return { ok: false, status: resp.status, body, fallbackable: isFallbackable(resp.status, body) };
    }

    const toolCalls: Record<number, { id?: string; name?: string; args: string }> = {};
    let assistantText = "";
    let finishReason: string | null = null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (rawLine: string) => {
      let line = rawLine;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) return;
      const jsonStr = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
      if (!jsonStr || jsonStr === "[DONE]") return;
      let evt: any;
      try { evt = JSON.parse(jsonStr); } catch { return; }
      const choice = evt?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        assistantText += delta.content;
        send(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const slot = toolCalls[idx] ?? { args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
          toolCalls[idx] = slot;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer.length > 0) handleLine(buffer);

    const calls = Object.values(toolCalls).filter((c) => c.name && c.id);
    if (calls.length === 0 || finishReason !== "tool_calls") return { ok: true };

    messages.push({
      role: "assistant",
      content: assistantText || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    });
    for (const c of calls) {
      let parsed: any = {};
      try { parsed = JSON.parse(c.args || "{}"); } catch { /* empty */ }
      status(statusFromToolCall(c.name!, parsed));
      const result = await runTool(supabase, c.name!, parsed);
      messages.push({ role: "tool", tool_call_id: c.id!, content: result });
    }
  }

  send("\n\n_(Joe stopped iterating after several tool calls — try a more specific question.)_");
  return { ok: true };
}

// ─── Text-only fallbacks (Gemini one-shot / OpenRouter streaming) ────────

async function streamGeminiOneShot(
  systemPrompt: string,
  messages: any[],
  send: (t: string) => void,
): Promise<StreamResult> {
  const userText = messages.map((m) => `${m.role.toUpperCase()}: ${flattenMessage(m).content}`).join("\n\n");
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
    }),
  });
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 400);
    return { ok: false, status: resp.status, body, fallbackable: isFallbackable(resp.status, body) };
  }
  const data = await resp.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text || "").join("") || "";
  if (!text) return { ok: false, status: 200, body: "empty", fallbackable: true };
  send(text);
  return { ok: true };
}

async function streamOpenRouter(
  systemPrompt: string,
  messages: any[],
  send: (t: string) => void,
): Promise<StreamResult> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://www.sullyrecruit.app",
      "X-Title": "Sully Recruit",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      stream: true,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map(flattenMessage)],
    }),
  });
  if (!resp.ok || !resp.body) {
    const body = resp.body ? await resp.text() : "";
    return { ok: false, status: resp.status, body, fallbackable: isFallbackable(resp.status, body) };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (rawLine: string) => {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.startsWith("data:")) return;
    const jsonStr = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
    if (!jsonStr || jsonStr === "[DONE]") return;
    let evt: any;
    try { evt = JSON.parse(jsonStr); } catch { return; }
    const t = evt?.choices?.[0]?.delta?.content;
    if (typeof t === "string") send(t);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  if (buffer.length > 0) handleLine(buffer);
  return { ok: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY && !GEMINI_API_KEY && !OPENROUTER_API_KEY) {
    return new Response(JSON.stringify({ error: "No AI keys configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { messages = [] } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));
      const status = (s: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: s })}\n\n`));

      try {
        if (ANTHROPIC_API_KEY) {
          const r = await streamAnthropicWithTools(supabase, BASE_SYSTEM_PROMPT, messages, send, status);
          if (r.ok) return;
          if (!r.fallbackable) { send(`\n\n[Joe error] Anthropic ${r.status}: ${r.body.slice(0, 200)}`); return; }
          console.warn("Anthropic failed, falling back:", r.status);
        }
        if (OPENAI_API_KEY) {
          const r = await streamOpenAIWithTools(supabase, BASE_SYSTEM_PROMPT, messages, send, status);
          if (r.ok) return;
          if (!r.fallbackable) { send(`\n\n[Joe error] OpenAI ${r.status}: ${r.body.slice(0, 200)}`); return; }
          console.warn("OpenAI failed, falling back:", r.status);
        }
        if (GEMINI_API_KEY) {
          const r = await streamGeminiOneShot(BASE_SYSTEM_PROMPT, messages, send);
          if (r.ok) return;
          if (!r.fallbackable) { send(`\n\n[Joe error] Gemini ${r.status}: ${r.body.slice(0, 200)}`); return; }
        }
        if (OPENROUTER_API_KEY) {
          const r = await streamOpenRouter(BASE_SYSTEM_PROMPT, messages, send);
          if (r.ok) return;
          send(`\n\n[Joe error] OpenRouter ${r.status}: ${r.body.slice(0, 200)}`);
          return;
        }
        send("\n\n[Joe error] No provider succeeded.");
      } catch (err: any) {
        send(`\n\n[Joe error] ${err?.message ?? String(err)}`);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});
