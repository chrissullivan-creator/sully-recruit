// Ask Joe — the conversational AI search surface for the Sully Recruit
// app. Streams a Claude → OpenAI → Gemini → OpenRouter cascade. Before
// streaming, the function builds a RAG context block from the user's
// most recent question: vector-search over resume_embeddings (Voyage)
// for candidate mode, ilike search over candidates with role='client'
// for contact mode. That snippet gets appended to the system prompt
// so Joe answers from the actual DB instead of just prior knowledge.
//
// Auth: requires a valid Supabase JWT (verify_jwt: true on deploy).
// Output: text/event-stream of `data: {"content":"..."}\n\n` lines.
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE_SYSTEM_PROMPT = `You are Joe — the AI backbone of Sully Recruit, built for The Emerald Recruiting Group, a Wall Street staffing firm. Sharp. Direct. Senior headhunter energy. Punchy, no walls of text.

Valid person statuses: new | reached_out | engaged. Never filter by back_of_resume or placed.

When the user asks a search question, ANSWER from the RELEVANT CANDIDATES / CONTACTS block injected below if present. If the block is missing or empty, say so plainly ("I couldn't find a match in the database") rather than inventing people. When you reference a person, include their candidate/contact ID in parentheses so the user can jump to their page.`;

// ─── Helpers ──────────────────────────────────────────────────────────

function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b: any) => (typeof b === "string" ? b : b?.text ?? ""))
        .join("\n");
    }
  }
  return "";
}

async function embedQuery(text: string): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: [text.slice(0, 8000)],
        input_type: "query",
      }),
    });
    if (!res.ok) {
      console.warn(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.warn("Voyage embed failed:", (err as Error).message);
    return null;
  }
}

async function buildCandidateContext(supabase: any, query: string): Promise<string> {
  const embedding = await embedQuery(query);
  if (!embedding) return "";

  const { data: matches, error } = await supabase.rpc("match_resume_embeddings", {
    query_embedding: embedding,
    match_count: TOP_K * 2,
    min_similarity: 0.3,
  });
  if (error || !matches?.length) return "";

  // Deduplicate by candidate_id, keeping the best similarity.
  const byId = new Map<string, any>();
  for (const row of matches as any[]) {
    const cid = row.candidate_id;
    if (!cid) continue;
    const prev = byId.get(cid);
    if (!prev || (row.similarity ?? 0) > (prev.similarity ?? 0)) {
      byId.set(cid, row);
    }
  }
  const ids = [...byId.keys()].slice(0, TOP_K);
  if (ids.length === 0) return "";

  const { data: cands } = await supabase
    .from("candidates")
    .select(
      "id, full_name, current_title, current_company, location, status, joe_says, primary_email, mobile_phone, linkedin_url, last_contacted_at, last_responded_at, roles",
    )
    .in("id", ids)
    .contains("roles", ["candidate"]);

  if (!cands?.length) return "";

  const lines = (cands as any[]).map((c) => {
    const m = byId.get(c.id);
    const sim = m?.similarity != null ? (m.similarity as number).toFixed(2) : "?";
    const last = c.last_responded_at
      ? `last replied ${c.last_responded_at.slice(0, 10)}`
      : c.last_contacted_at
        ? `last reached ${c.last_contacted_at.slice(0, 10)}`
        : "no recent contact";
    const notes = c.joe_says ? ` Notes: ${String(c.joe_says).slice(0, 220)}` : "";
    return `- ${c.full_name} — ${c.current_title || "?"} at ${c.current_company || "?"}, ${c.location || "no location"}. Status: ${c.status || "new"}. Match: ${sim}. ID: ${c.id}. ${last}.${notes}`;
  });

  return `\n\nRELEVANT CANDIDATES from the database (top ${cands.length}, vector-matched):\n${lines.join("\n")}`;
}

async function buildContactContext(supabase: any, query: string): Promise<string> {
  // Try vector search over joe_says briefs first. Only briefed clients
  // are searchable this way; the long tail still falls back to ilike.
  const embedding = await embedQuery(query);
  if (embedding) {
    const { data: matches, error: matchErr } = await supabase.rpc("match_people_joe_says", {
      query_embedding: embedding,
      match_count: TOP_K,
      min_similarity: 0.3,
      role_filter: "client",
    });
    if (!matchErr && matches?.length) {
      const ids = (matches as any[]).map((m: any) => m.person_id);
      const { data: contacts } = await supabase
        .from("candidates")
        .select(
          "id, full_name, current_title, current_company, location, primary_email, mobile_phone, linkedin_url, last_contacted_at, roles",
        )
        .in("id", ids)
        .contains("roles", ["client"]);
      if (contacts?.length) {
        const byId = new Map((matches as any[]).map((m: any) => [m.person_id, m]));
        const lines = (contacts as any[]).map((c) => {
          const m: any = byId.get(c.id);
          const sim = m?.similarity != null ? Number(m.similarity).toFixed(2) : "?";
          const last = c.last_contacted_at ? `last reached ${c.last_contacted_at.slice(0, 10)}` : "no recent contact";
          const excerpt = m?.joe_says_excerpt ? ` Brief: ${String(m.joe_says_excerpt).slice(0, 200)}` : "";
          return `- ${c.full_name} — ${c.current_title || "?"} at ${c.current_company || "?"}, ${c.location || "?"}. Email: ${c.primary_email || "?"}. ID: ${c.id}. Match: ${sim}. ${last}.${excerpt}`;
        });
        return `\n\nRELEVANT CONTACTS from the database (top ${contacts.length}, brief-vector-matched):\n${lines.join("\n")}`;
      }
    }
  }

  // Keyword fallback for contacts that don't have a joe_says brief yet.
  const keywords = query
    .split(/\s+/)
    .filter((k) => k.length >= 3)
    .slice(0, 4);
  if (keywords.length === 0) return "";
  const orFilter = keywords
    .map((k) => `full_name.ilike.%${k}%,current_title.ilike.%${k}%,current_company.ilike.%${k}%`)
    .join(",");

  const { data, error } = await supabase
    .from("candidates")
    .select(
      "id, full_name, current_title, current_company, location, primary_email, mobile_phone, linkedin_url, last_contacted_at, roles",
    )
    .or(orFilter)
    .contains("roles", ["client"])
    .limit(TOP_K);

  if (error || !data?.length) return "";
  const lines = (data as any[]).map((c) => {
    const last = c.last_contacted_at ? `last reached ${c.last_contacted_at.slice(0, 10)}` : "no recent contact";
    return `- ${c.full_name} — ${c.current_title || "?"} at ${c.current_company || "?"}, ${c.location || "?"}. Email: ${c.primary_email || "?"}. ID: ${c.id}. ${last}.`;
  });
  return `\n\nRELEVANT CONTACTS from the database (top ${data.length}, keyword-matched):\n${lines.join("\n")}`;
}

// ─── Streaming providers ──────────────────────────────────────────────

type StreamResult =
  | { ok: true }
  | { ok: false; status: number; body: string; fallbackable: boolean };

const FALLBACK_REGEX =
  /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key|overloaded|quota|exhausted|unavailable|503|500/i;

function isFallbackable(status: number, body: string): boolean {
  if (status >= 500) return true;
  if (status === 429 || status === 401 || status === 403) return true;
  return FALLBACK_REGEX.test(body || "");
}

async function streamAnthropic(
  systemPrompt: string,
  messages: any[],
  send: (t: string) => void,
): Promise<StreamResult> {
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
      messages,
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
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
      const t = evt.delta.text;
      if (typeof t === "string") send(t);
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
  return { ok: true };
}

function flattenMessage(m: any): { role: string; content: string } {
  return {
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((b: any) => (typeof b === "string" ? b : (b?.text ?? ""))).join("\n")
      : m.content,
  };
}

async function streamOpenAICompatible(
  url: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: any[],
  send: (t: string) => void,
  extraHeaders: Record<string, string> = {},
): Promise<StreamResult> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(flattenMessage),
      ],
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

// Gemini doesn't have a clean SSE delta stream that maps to our protocol;
// we fall back to a single-shot response and emit it as one chunk. Still
// honors the cascade contract — the user sees Joe's answer either way.
async function streamGeminiOneShot(
  systemPrompt: string,
  messages: any[],
  send: (t: string) => void,
): Promise<StreamResult> {
  const userText = messages
    .map((m) => `${m.role.toUpperCase()}: ${flattenMessage(m).content}`)
    .join("\n\n");
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
  const text =
    (data?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text || "")
      .join("") || "";
  if (!text) return { ok: false, status: 200, body: "empty", fallbackable: true };
  send(text);
  return { ok: true };
}

// ─── Handler ──────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY && !GEMINI_API_KEY && !OPENROUTER_API_KEY) {
    return new Response(
      JSON.stringify({ error: "No AI keys configured (need ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { messages = [], mode = "candidate_search" } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const userQuery = lastUserText(messages);

  // Build the RAG context block before streaming. Failures are logged
  // and Joe answers without the block rather than blocking the chat.
  let contextBlock = "";
  try {
    contextBlock =
      mode === "contact_search"
        ? await buildContactContext(supabase, userQuery)
        : await buildCandidateContext(supabase, userQuery);
  } catch (err) {
    console.warn("RAG context build failed:", (err as Error).message);
  }

  const systemPrompt = BASE_SYSTEM_PROMPT + contextBlock;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));

      try {
        // ─ Stage 1: Claude (preferred — strongest at this domain) ─
        if (ANTHROPIC_API_KEY) {
          const r = await streamAnthropic(systemPrompt, messages, send);
          if (r.ok) return;
          if (!r.fallbackable) {
            send(`\n\n[Joe error] Anthropic ${r.status}: ${r.body.slice(0, 200)}`);
            return;
          }
          console.warn("Anthropic failed, falling back:", r.status, r.body.slice(0, 200));
        }

        // ─ Stage 2: OpenAI ─
        if (OPENAI_API_KEY) {
          const r = await streamOpenAICompatible(
            "https://api.openai.com/v1/chat/completions",
            OPENAI_API_KEY,
            OPENAI_MODEL,
            systemPrompt,
            messages,
            send,
          );
          if (r.ok) return;
          if (!r.fallbackable) {
            send(`\n\n[Joe error] OpenAI ${r.status}: ${r.body.slice(0, 200)}`);
            return;
          }
          console.warn("OpenAI failed, falling back:", r.status, r.body.slice(0, 200));
        }

        // ─ Stage 3: Gemini ─
        if (GEMINI_API_KEY) {
          const r = await streamGeminiOneShot(systemPrompt, messages, send);
          if (r.ok) return;
          if (!r.fallbackable) {
            send(`\n\n[Joe error] Gemini ${r.status}: ${r.body.slice(0, 200)}`);
            return;
          }
          console.warn("Gemini failed, falling back:", r.status, r.body.slice(0, 200));
        }

        // ─ Stage 4: OpenRouter (final escape hatch) ─
        if (OPENROUTER_API_KEY) {
          const r = await streamOpenAICompatible(
            "https://openrouter.ai/api/v1/chat/completions",
            OPENROUTER_API_KEY,
            OPENROUTER_MODEL,
            systemPrompt,
            messages,
            send,
            { "HTTP-Referer": "https://www.sullyrecruit.app", "X-Title": "Sully Recruit" },
          );
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
