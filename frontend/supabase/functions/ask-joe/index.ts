// Ask Joe with tool use: streams an OpenAI → Claude → Gemini → OpenRouter
// cascade (OpenAI-first per the AI-native roadmap). OpenAI + Claude run with
// tool-use enabled; Gemini + OpenRouter answer text-only without tools —
// they're only hit when the upstream providers fail.
//
// Tools: 10 read-only CRM tools always. When the JOE_AGENTIC_ENABLED app_setting
// is on, an additional propose-only write tier (draft_message,
// enroll_in_sequence, move_pipeline_stage, create_task, add_note) is loaded.
// Those tools NEVER write — they emit an `action` SSE event that the client
// renders as an approve/edit/reject card; the write happens only on approval.
//
// Auth: requires a valid Supabase JWT (verify_jwt: true on deploy).
// SSE output:
//   data: {"content":"..."}              -- streaming text from the model
//   data: {"status":"Joe is searching..."} -- short ephemeral status line
//   data: {"action":{...}}                -- a proposed action card (agentic)
//
// Safety: read tools are read-only; write tools are propose-only and
// do_not_contact-guarded; max 6 iterations per turn; 12s per tool; bodies are
// truncated before being injected back to the model.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Provider keys default to the edge-function secrets but are refreshed from
// app_settings on each request (see refreshKeysFromAppSettings). app_settings is
// the app-wide source the Vercel functions read and keep current; the Deno.env
// edge secrets drift stale — that's what silently broke Joe ("No provider
// succeeded"). `let` so the per-request refresh can override them.
let ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??
  "";
let OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
let GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
let OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
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

You have tools for searching the CRM. Use them whenever the user's question requires a fact about a specific person, job, communication, send-out, note, or company in the database — don't guess from memory. Chain tools when useful (e.g. search_people → get_person_detail → list_recent_communications). For "who are the contacts/people at <company>" questions, use list_company_people (it resolves the company and lists everyone linked to it) rather than search_people. When the question is about what was actually SAID in a message — find/search an email, LinkedIn DM, or Recruiter InMail by its content ("find the InMail mentioning X", "who messaged about the Citadel role") — use search_messages, then chain to get_person_detail on the returned person_id when you need more.

When you reference a person or job, include their ID in parentheses so the recruiter can jump to their page. If a search returns no matches, say so plainly — don't invent people. BUT if a tool result contains a "diagnostic" field, the search backend failed (not an empty database) — tell the recruiter search is temporarily broken and briefly relay the diagnostic; never claim "no candidates found" in that case.`;

// Appended only when JOE_AGENTIC_ENABLED is on and the write-tools are loaded.
const AGENTIC_PROMPT_SUFFIX = `

You can also PROPOSE actions: draft_message, enroll_in_sequence, move_pipeline_stage, create_task, add_note. These do NOT execute — each shows the recruiter an approve/edit/reject card. Only propose an action when the user clearly asks for it (e.g. "draft an email to X", "enroll her", "move him to submitted", "remind me to follow up", "note that..."). After proposing, say in one short line what you put up for approval. Never claim an action is done — it only happens if they approve.`;

const TOOLS = [
  {
    name: "search_people",
    description:
      "Semantic + keyword search across candidates. Combines vector search over resume_embeddings + joe_says briefs with an overlap-ranked keyword search that scores candidates by how many of the query's attributes match across their title, current company, location, target roles/locations, products, and departments — so multi-attribute asks like \"executive director at Morgan Stanley in research\" or \"interest rates middle office candidates\" return the people matching the MOST attributes first. Returns id, name, title/company, status, match score, and a brief excerpt. Pass the full natural-language ask as `query` (the tool extracts the meaningful terms itself — don't pre-strip it).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The full natural-language description of who to find (e.g. 'ED at Morgan Stanley in research with a resume'). Include company, title, desk/product, location — the tool ranks by how many match." },
        role: { type: "string", enum: ["candidate", "client"], description: "Restrict to candidates or clients only. Omit to search both." },
        status: { type: "string", enum: ["new", "reached_out", "engaged"], description: "Restrict to a specific status." },
        has_resume: { type: "boolean", description: "When true, only return candidates we have a resume on file for. Set this when the user asks for people 'with a resume'." },
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
    name: "search_messages",
    description:
      "Full-text search across ALL communications (email, LinkedIn DM, LinkedIn Recruiter InMail, SMS) by the actual message content — not just per person. Use this for questions like \"find the InMail where someone mentioned a $2M mandate\", \"who emailed about the Citadel role\", \"search messages for 'relocation'\", or \"what did Kwaku say about timing\". Returns the matching messages with the sender, channel, direction, a snippet around the match, the timestamp, and the linked person id (when known) so you can drill in with get_person_detail. Optionally filter by channel or restrict to one person.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words/phrase to search for in the message body or subject." },
        channel: {
          type: "string",
          enum: ["email", "linkedin", "linkedin_recruiter", "sms"],
          description: "Restrict to one channel. Omit to search all.",
        },
        person_id: { type: "string", description: "Optional uuid — restrict to messages linked to this person." },
        limit: { type: "number", description: "Max rows (1-25). Default 12." },
      },
      required: ["query"],
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
    name: "match_candidates_to_job",
    description:
      "Given a job id, find the candidates in our database who best fit it. Loads the job (title, company, description), runs semantic search over resume_embeddings, and returns the top ranked candidates with id, name, title, company, match_score, and an excerpt. Candidates we've already spoken to (call history) are flagged vetted:true and ranked first. Use this for questions like \"who do we have for this role?\", \"match candidates to job X\", or \"who should we submit?\".",
    input_schema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "uuid of the job to match candidates against" },
        limit: { type: "number", description: "Max candidates to return (1-50). Default 20." },
      },
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
  {
    name: "list_company_people",
    description:
      "List the people at a company — the contacts/clients you work with there plus any candidates who work there. Use this for \"who are the contacts/people at <company>\" or \"who do we know at <company>\". Resolves the company by name and returns everyone linked to it (by the canonical company link, plus a company-name text fallback): id, name, title, role (candidate or client), status, email, linkedin. Prefer this over search_people for company-roster questions.",
    input_schema: {
      type: "object",
      properties: {
        company: { type: "string", description: "Company name, e.g. 'Jain Global'." },
        role: { type: "string", enum: ["candidate", "client"], description: "Optional: restrict to candidates or clients (contacts) only." },
        limit: { type: "number", description: "Max rows (1-100). Default 50." },
      },
      required: ["company"],
    },
  },
];

// ── Agentic write-tools (Phase 2) ──────────────────────────────────────────
// Gated behind the JOE_AGENTIC_ENABLED app_setting. These tools NEVER perform
// a side effect on the backend — each one validates guardrails and returns a
// *proposal* that is surfaced to the recruiter as an approve/edit/reject action
// card. The recruiter's client performs the actual write only on approval. So
// even a buggy tool here cannot send a message, enroll, or move a stage.
const WRITE_TOOLS = [
  {
    name: "draft_message",
    description:
      "Propose a draft outreach message to a person (the recruiter reviews and sends it — this does NOT send). Use when the user asks to write/draft/reach out. Returns a proposal card.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "uuid of the person to message" },
        channel: { type: "string", enum: ["email", "linkedin", "sms"], description: "Channel to draft for." },
        purpose: { type: "string", description: "What the message should accomplish, in a phrase." },
      },
      required: ["person_id", "channel", "purpose"],
    },
  },
  {
    name: "enroll_in_sequence",
    description:
      "Propose enrolling one or more people into an outreach sequence. The recruiter approves a single card that then enrolls everyone on it — this tool itself does NOT enroll. List every person to add in person_ids (enroll several at once in ONE call, not one call each). do_not_contact people are dropped automatically. Returns a proposal card.",
    input_schema: {
      type: "object",
      properties: {
        person_ids: {
          type: "array",
          items: { type: "string" },
          description: "uuids of the people to enroll (one or more). Get them from search_people first.",
        },
        sequence_query: { type: "string", description: "Name (or distinctive keywords) of the sequence to enroll into." },
      },
      required: ["person_ids", "sequence_query"],
    },
  },
  {
    name: "move_pipeline_stage",
    description:
      "Propose moving a candidate to a pipeline stage (the recruiter confirms — this does NOT move). Returns a proposal card.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "uuid of the candidate" },
        job_id: { type: "string", description: "uuid of the job (optional but preferred)" },
        to_stage: { type: "string", description: "Target stage, e.g. pitch, submitted, interview, offer, placed, withdrawn." },
      },
      required: ["person_id", "to_stage"],
    },
  },
  {
    name: "create_task",
    description:
      "Propose creating a follow-up task / reminder (the recruiter confirms). Returns a proposal card.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        person_id: { type: "string", description: "uuid of the related person (optional)." },
        due_date: { type: "string", description: "ISO date (YYYY-MM-DD), optional." },
      },
      required: ["title"],
    },
  },
  {
    name: "add_note",
    description: "Propose adding a note to a person's record (the recruiter confirms). Returns a proposal card.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "uuid of the person" },
        note: { type: "string", description: "The note text." },
      },
      required: ["person_id", "note"],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

const toOpenAITools = (list: any[]) =>
  list.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

const OPENAI_TOOLS = toOpenAITools(TOOLS);

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

/**
 * Run an RPC but never swallow the error. A Postgres error here (missing
 * function from an unapplied migration, a renamed column, an RLS denial) used to
 * surface as an empty `data`, which the search tools then reported as "no
 * matches" — making a broken migration or an undeployed edge function
 * indistinguishable from a genuinely empty result. That is exactly why Ask Joe
 * could "find nothing" for every query with no way to tell why. Log it and hand
 * the caller the message so it can be reported in the tool's `diagnostic`.
 */
async function callRpc(
  supabase: any,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: any[] | null; error: string | null }> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const msg = error.message ?? String(error);
    console.error(`ask-joe rpc ${fn} failed: ${msg}`);
    return { data: null, error: `${fn}: ${msg}` };
  }
  return { data: (data as any[]) ?? null, error: null };
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
    case "search_messages": {
      const q = input?.query ? `"${String(input.query).slice(0, 40)}"` : "messages";
      return `Joe is searching messages for ${q}…`;
    }
    case "list_notes": return "Joe is reading recruiter notes…";
    case "list_send_outs": return "Joe is reviewing the pipeline…";
    case "list_jobs": return "Joe is searching jobs…";
    case "get_job_detail": return "Joe is pulling the job…";
    case "match_candidates_to_job": return "Joe is matching candidates to the job…";
    case "search_companies": return "Joe is searching companies…";
    case "list_company_people": {
      const c = String(input?.company ?? "").slice(0, 60);
      return `Joe is pulling people at ${c || "the company"}…`;
    }
    default: return `Joe is running ${name}…`;
  }
}

// ─── Tool implementations ────────────────────────────────────────────────

// Words that carry no search signal — generic verbs, fillers, and role/meta
// words handled by other params (role / has_resume). Stripped before the
// overlap search so "show me an executive director from morgan stanley" keys on
// {executive, director, morgan, stanley}, not {show, from, that}.
const SEARCH_STOPWORDS = new Set([
  "show", "me", "find", "get", "who", "whom", "that", "this", "these", "those",
  "works", "work", "working", "with", "and", "has", "have", "had", "from", "the",
  "for", "are", "was", "were", "our", "your", "you", "but", "list", "give", "need",
  "want", "looking", "look", "someone", "anyone", "people", "person", "candidate",
  "candidates", "client", "clients", "contact", "contacts", "resume", "resumes",
  "cv", "profile", "any", "all", "please", "can", "does", "currently", "current",
  "experience", "experienced", "years", "year", "background", "based", "about",
  "their", "they", "them", "his", "her", "into", "out", "good", "great", "best",
  "top", "some", "more", "most", "show me",
]);

/** Pull the meaningful search terms out of a natural-language query: lowercase,
 *  split on non-alphanumerics, drop stopwords + sub-3-char tokens, dedupe, cap. */
function extractTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9&+]+/)) {
    const t = raw.trim();
    if (t.length < 3) continue;
    if (SEARCH_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
    if (terms.length >= 8) break;
  }
  return terms;
}

async function toolSearchPeople(supabase: any, input: any): Promise<string> {
  const query = String(input?.query ?? "").slice(0, 500);
  const role = input?.role === "candidate" || input?.role === "client" ? input.role : null;
  const status = typeof input?.status === "string" ? input.status : null;
  const limit = Math.min(Math.max(Number(input?.limit) || TOP_K, 1), 20);

  const embedding = await embedQuery(query);
  const idScore = new Map<string, { score: number; via: string; excerpt?: string }>();
  // Collect the reason each retrieval path contributed nothing so an empty
  // result set is explainable (broken RPC vs. missing embeddings vs. genuinely
  // no data) instead of a silent "no matches".
  const diagnostics: string[] = [];
  if (!embedding) diagnostics.push("semantic search skipped (no embedding — VOYAGE_API_KEY may be unset)");

  if (embedding && (!role || role === "candidate")) {
    const { data, error } = await callRpc(supabase, "match_resume_embeddings", {
      query_embedding: embedding,
      match_count: limit * 2,
      min_similarity: 0.3,
    });
    if (error) diagnostics.push(error);
    for (const r of data ?? []) {
      if (!r.candidate_id) continue;
      const prev = idScore.get(r.candidate_id);
      if (!prev || prev.score < r.similarity) {
        idScore.set(r.candidate_id, { score: r.similarity, via: "resume" });
      }
    }
  }

  if (embedding) {
    const { data, error } = await callRpc(supabase, "match_people_joe_says", {
      query_embedding: embedding,
      match_count: limit * 2,
      min_similarity: 0.3,
      role_filter: role,
    });
    if (error) diagnostics.push(error);
    for (const r of data ?? []) {
      if (!r.person_id) continue;
      const prev = idScore.get(r.person_id);
      const sim = Number(r.similarity ?? 0);
      const score = sim + 0.02; // bias brief matches slightly above resume matches
      if (!prev || prev.score < score) {
        idScore.set(r.person_id, { score, via: "brief", excerpt: r.joe_says_excerpt });
      }
    }
  }

  // Overlap-ranked keyword search (candidates): rank by how many query terms hit
  // the candidate's title / company / location / target roles+locations /
  // products / departments, so multi-attribute asks surface the people matching
  // the MOST attributes first — the old OR-with-4-word-cap missed them entirely.
  // This path does NOT need embeddings, so it must keep working even when the
  // semantic paths are down — it's the safety net for Ask Joe.
  const terms = extractTerms(query);
  const wantResume = input?.has_resume === true || /\b(resume|resumes|cv)\b/i.test(query);
  if (terms.length && role !== "client") {
    const { data, error } = await callRpc(supabase, "search_people_overlap", {
      p_terms: terms,
      p_want_resume: wantResume,
      p_status: status,
      p_max_rows: limit * 2,
    });
    if (error) diagnostics.push(error);
    const denom = Math.max(terms.length, 1);
    for (const r of data ?? []) {
      if (!r.id) continue;
      // Scale into the same band as the embedding similarities (~0.3–0.95) so a
      // full attribute match ranks at/above a strong semantic hit.
      const kwScore = 0.4 + 0.55 * (Math.min(Number(r.overlap) || 0, denom) / denom);
      const prev = idScore.get(r.id);
      if (!prev || prev.score < kwScore) {
        idScore.set(r.id, { score: kwScore, via: prev?.via ?? "keyword" });
      }
    }
  } else if (!terms.length) {
    diagnostics.push("keyword search skipped (query had no meaningful terms after stopword removal)");
  }

  if (idScore.size === 0) {
    // Surface WHY nothing came back. If every path errored, that's an
    // infrastructure problem (unapplied migration / undeployed function /
    // missing key), not an empty database — say so instead of "no matches".
    return JSON.stringify(
      diagnostics.length
        ? { results: [], note: "no matches", diagnostic: diagnostics }
        : { results: [], note: "no matches" },
    );
  }

  const ids = [...idScore.keys()].slice(0, limit * 2);
  let q = supabase
    .from("candidates")
    .select(
      "id, full_name, current_title, current_company, location, status, primary_email, mobile_phone, linkedin_url, last_contacted_at, last_responded_at, roles",
    )
    .in("id", ids);
  // Only narrow by the roles array for client searches — candidates are already
  // scoped by the candidates view, and ~15% lack the 'candidate' role tag, so
  // applying it there silently dropped real matches.
  if (role === "client") q = q.contains("roles", [role]);
  if (status) q = q.eq("status", status);
  const { data: rows, error: rowsErr } = await q;
  if (rowsErr) {
    console.error(`ask-joe candidates fetch failed: ${rowsErr.message}`);
    return JSON.stringify({ results: [], note: "no matches", diagnostic: [`candidates fetch: ${rowsErr.message}`] });
  }

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

// Full-text-ish search across all message bodies/subjects so Joe can answer
// content questions ("find the InMail about X"). Keyword search via ilike on
// body + subject, optional channel / person filters. Each hit carries the
// sender, channel, a snippet around the match, and the linked person id.
async function toolSearchMessages(supabase: any, input: any): Promise<string> {
  const query = String(input?.query ?? "").trim();
  if (!query) return JSON.stringify({ error: "query required" });
  const limit = Math.min(Math.max(Number(input?.limit) || 12, 1), 25);
  const channel = String(input?.channel ?? "").trim();
  const personId = String(input?.person_id ?? "").trim();

  // Escape ilike wildcards in the user's text so % / _ are literal.
  const safe = query.replace(/[%_]/g, (m) => `\\${m}`);

  let q = supabase
    .from("messages")
    .select(
      "id, conversation_id, channel, direction, subject, body, sender_name, sent_at, received_at, created_at, candidate_id, contact_id",
    )
    .or(`body.ilike.%${safe}%,subject.ilike.%${safe}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (channel) q = q.eq("channel", channel);
  if (personId) q = q.or(`candidate_id.eq.${personId},contact_id.eq.${personId}`);

  const { data, error } = await q;
  if (error) return JSON.stringify({ error: error.message });

  // Resolve person names for the linked ids in one round-trip.
  const ids = Array.from(
    new Set(
      ((data as any[]) ?? [])
        .flatMap((m) => [m.candidate_id, m.contact_id])
        .filter((x: any): x is string => !!x),
    ),
  );
  const nameById = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await supabase.from("people").select("id, full_name").in("id", ids);
    for (const p of (people as any[]) ?? []) nameById.set(p.id, p.full_name);
  }

  const snippet = (body: string | null): string => {
    const text = (body ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return text.slice(0, 240);
    const start = Math.max(0, idx - 80);
    return (start > 0 ? "…" : "") + text.slice(start, idx + query.length + 160) + "…";
  };

  const items = ((data as any[]) ?? []).map((m) => {
    const pid = m.candidate_id ?? m.contact_id ?? null;
    return {
      message_id: m.id,
      conversation_id: m.conversation_id,
      channel: m.channel,
      direction: m.direction,
      subject: m.subject ?? null,
      snippet: snippet(m.body),
      sender_name: m.sender_name ?? null,
      person_id: pid,
      person_name: pid ? nameById.get(pid) ?? null : null,
      sent_at: m.sent_at ?? m.received_at ?? m.created_at ?? null,
    };
  });

  return JSON.stringify({ count: items.length, items });
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

async function toolMatchCandidatesToJob(supabase: any, input: any): Promise<string> {
  const jobId = String(input?.job_id ?? "").trim();
  if (!jobId) return JSON.stringify({ error: "job_id required" });
  const limit = Math.min(Math.max(Number(input?.limit) || 20, 1), 50);

  // Load the job (same query as get_job_detail) for the match text.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, title, company_name, location, status, description")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr || !job) return JSON.stringify({ error: jobErr?.message ?? "job_not_found" });

  const matchText = [job.title, job.company_name, job.description]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" ")
    .slice(0, 8000);
  if (!matchText.trim()) {
    return JSON.stringify({ job: { id: job.id, title: job.title }, results: [], note: "job has no title/description to match on" });
  }

  // Same retrieval toolSearchPeople uses, candidate role only.
  const embedding = await embedQuery(matchText);
  if (!embedding) {
    return JSON.stringify({ job: { id: job.id, title: job.title }, results: [], note: "embedding unavailable" });
  }
  const idScore = new Map<string, { score: number; via: string; excerpt?: string }>();
  const { data: matches, error: matchErr } = await callRpc(supabase, "match_resume_embeddings", {
    query_embedding: embedding,
    match_count: limit * 3,
    min_similarity: 0.3,
  });
  if (matchErr) {
    return JSON.stringify({ job: { id: job.id, title: job.title }, results: [], note: "no matches", diagnostic: [matchErr] });
  }
  for (const r of matches ?? []) {
    if (!r.candidate_id) continue;
    const prev = idScore.get(r.candidate_id);
    if (!prev || prev.score < r.similarity) {
      idScore.set(r.candidate_id, { score: r.similarity, via: "resume" });
    }
  }
  if (idScore.size === 0) return JSON.stringify({ job: { id: job.id, title: job.title }, results: [], note: "no matches" });

  const ids = [...idScore.keys()].slice(0, limit * 3);
  const { data: rows } = await supabase
    .from("candidates")
    .select("id, full_name, current_title, current_company, location, status")
    .in("id", ids)
    .contains("roles", ["candidate"]);

  // Flag candidates we've actually spoken to (call_logs or ai_call_notes) as
  // vetted so Joe can favour and rank them first.
  const candidateIds = ((rows as any[]) ?? []).map((r) => r.id).filter(Boolean);
  const vettedIds = new Set<string>();
  if (candidateIds.length > 0) {
    const [logsRes, notesRes] = await Promise.all([
      supabase.from("call_logs").select("candidate_id").in("candidate_id", candidateIds),
      supabase.from("ai_call_notes").select("candidate_id").in("candidate_id", candidateIds),
    ]);
    for (const r of (logsRes.data as any[]) ?? []) if (r.candidate_id) vettedIds.add(r.candidate_id);
    for (const r of (notesRes.data as any[]) ?? []) if (r.candidate_id) vettedIds.add(r.candidate_id);
  }

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
        match_score: meta ? Number(meta.score.toFixed(3)) : null,
        match_via: meta?.via ?? "resume",
        excerpt: meta?.excerpt ?? null,
        vetted: vettedIds.has(r.id),
      };
    })
    // Vetted (already spoken to) first, then by match score.
    .sort((a: any, b: any) => {
      if (a.vetted !== b.vetted) return a.vetted ? -1 : 1;
      return (b.match_score ?? 0) - (a.match_score ?? 0);
    })
    .slice(0, limit);

  return JSON.stringify({
    job: { id: job.id, title: job.title, company: job.company_name },
    results,
  });
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

async function toolListCompanyPeople(supabase: any, input: any): Promise<string> {
  const companyQ = String(input?.company ?? "").trim();
  if (!companyQ) return JSON.stringify({ error: "company required" });
  const role = input?.role === "candidate" || input?.role === "client" ? input.role : null;
  const limit = Math.min(Math.max(Number(input?.limit) || 50, 1), 100);

  // Resolve company ids by name so we can filter on the canonical company_id
  // link — the reliable way to list a company's people (company text is messy:
  // clients keep their firm in company_name with current_company null).
  const { data: companyRows } = await supabase
    .from("companies").select("id, name").ilike("name", `%${companyQ}%`).limit(10);
  const companyIds = ((companyRows as any[]) ?? []).map((c) => c.id).filter(Boolean);

  const cols =
    "id, full_name, current_title, current_company, company_name, type, status, primary_email, linkedin_url, do_not_contact";
  const byId = new Map<string, any>();

  // Primary: linked by company_id.
  if (companyIds.length) {
    let q = supabase.from("people").select(cols).in("company_id", companyIds).is("deleted_at", null).limit(limit * 2);
    if (role) q = q.eq("type", role);
    const { data } = await q;
    for (const r of (data as any[]) ?? []) byId.set(r.id, { ...r, linked: true });
  }

  // Fallback: company-name text on either field — catches people not yet linked
  // (e.g. a name variant the auto-link trigger hasn't claimed).
  {
    let q = supabase.from("people").select(cols)
      .or(`current_company.ilike.%${companyQ}%,company_name.ilike.%${companyQ}%`)
      .is("deleted_at", null).limit(limit * 2);
    if (role) q = q.eq("type", role);
    const { data } = await q;
    for (const r of (data as any[]) ?? []) if (!byId.has(r.id)) byId.set(r.id, { ...r, linked: false });
  }

  const people = [...byId.values()].slice(0, limit).map((r) => ({
    id: r.id,
    name: r.full_name,
    title: r.current_title,
    company: r.current_company ?? r.company_name,
    role: r.type,
    status: r.status,
    email: r.primary_email ?? null,
    linkedin_url: r.linkedin_url ?? null,
    do_not_contact: !!r.do_not_contact,
    linked_by_company: !!r.linked,
  }));

  return JSON.stringify({
    company_query: companyQ,
    matched_companies: ((companyRows as any[]) ?? []).map((c) => c.name),
    count: people.length,
    people,
  });
}

async function getPersonBrief(supabase: any, personId: string): Promise<any> {
  const { data } = await supabase
    .from("people")
    .select("id, full_name, first_name, last_name, type, do_not_contact")
    .eq("id", personId)
    .maybeSingle();
  return data;
}

function personName(p: any): string {
  return p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(" ") || "this person";
}

// Resolve the sequence (by name) + the people, drop do_not_contact, and emit a
// SINGLE enroll card the client executes on approval. Never enrolls here — the
// recruiter's approval is what triggers the actual enrollment client-side.
async function handleEnrollProposal(
  supabase: any,
  input: any,
  emitAction: (a: any) => void,
): Promise<string> {
  const rawIds = Array.isArray(input?.person_ids)
    ? input.person_ids
    : input?.person_id
      ? [input.person_id]
      : [];
  const ids = [...new Set(rawIds.map((s: any) => String(s ?? "").trim()).filter(Boolean))];
  const seqQuery = String(input?.sequence_query ?? "").trim();
  if (ids.length === 0) return JSON.stringify({ error: "person_ids required" });
  if (!seqQuery) return JSON.stringify({ error: "sequence_query required" });

  // Resolve the sequence by name. One match → use it; several → prefer an exact
  // (case-insensitive) name, else ask which; none → ask for the exact name.
  // Never guess across multiple sequences.
  const { data: seqRows } = await supabase
    .from("sequences")
    .select("id, name, status")
    .ilike("name", `%${seqQuery}%`)
    .limit(10);
  const matches = ((seqRows as any[]) ?? []).filter((s) => s?.id);
  let seq: any = null;
  if (matches.length === 1) {
    seq = matches[0];
  } else if (matches.length > 1) {
    seq = matches.find((s) => String(s.name ?? "").trim().toLowerCase() === seqQuery.toLowerCase()) ?? null;
    if (!seq) {
      return JSON.stringify({
        ambiguous: true,
        reason: `Several sequences match "${seqQuery}". Ask the recruiter which one, then call again.`,
        options: matches.map((s) => ({ name: s.name, status: s.status })),
      });
    }
  }
  if (!seq) {
    return JSON.stringify({
      not_found: true,
      reason: `No sequence matches "${seqQuery}". Ask the recruiter for the exact sequence name.`,
    });
  }

  // Resolve people; silently drop do_not_contact (outreach guard) + unknown ids.
  // Tolerant: each identifier may be a CRM uuid (preferred) OR a name/email —
  // Joe doesn't always carry the uuid across turns, and failing to resolve a
  // person it just listed reads as nonsense to the recruiter. uuids resolve by
  // id; everything else resolves by email (if it looks like one) then name.
  const PCOLS = "id, full_name, first_name, last_name, type, roles, do_not_contact";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const byKey = new Map<string, any>(); // original identifier -> resolved person

  const uuids = ids.filter((x: string) => UUID_RE.test(String(x)));
  const terms = ids.filter((x: string) => !UUID_RE.test(String(x)));

  if (uuids.length) {
    const { data } = await supabase.from("people").select(PCOLS).in("id", uuids).is("deleted_at", null);
    const m = new Map(((data as any[]) ?? []).map((p) => [p.id, p]));
    for (const u of uuids) { const p = m.get(u); if (p) byKey.set(u, p); }
  }

  for (const term of terms) {
    const t = String(term).trim();
    if (!t) continue;
    let row: any = null;
    if (t.includes("@")) {
      const lc = t.toLowerCase();
      const { data } = await supabase
        .from("people").select(PCOLS)
        .or(`work_email.ilike.${lc},personal_email.ilike.${lc}`)
        .is("deleted_at", null).limit(2);
      row = (data as any[])?.[0] ?? null;
    } else {
      const { data } = await supabase
        .from("people").select(PCOLS)
        .ilike("full_name", `%${t}%`)
        .is("deleted_at", null).limit(5);
      const rows = (data as any[]) ?? [];
      // Prefer an exact case-insensitive full-name hit; else the lone match.
      row = rows.find((p) => String(p.full_name ?? "").trim().toLowerCase() === t.toLowerCase())
        ?? (rows.length ? rows[0] : null);
    }
    if (row) byKey.set(term, row);
  }

  const people: any[] = [];
  const blocked: string[] = [];
  let unresolved = 0;
  const addedIds = new Set<string>();
  for (const id of ids) {
    const p: any = byKey.get(id);
    if (!p) { unresolved++; continue; }
    if (p.do_not_contact) { blocked.push(personName(p)); continue; }
    if (addedIds.has(p.id)) continue; // two identifiers resolved to the same person
    addedIds.add(p.id);
    people.push({ person_id: p.id, name: personName(p), type: p.type, roles: p.roles ?? [] });
  }

  if (people.length === 0) {
    return JSON.stringify({
      refused: true,
      reason: blocked.length
        ? `Everyone requested is marked do_not_contact (${blocked.join(", ")}) — nothing to enroll.`
        : "None of those people could be resolved — re-check the ids with search_people.",
    });
  }

  const actionId = crypto.randomUUID();
  const names = people.map((p) => p.name);
  const previewParts = [names.join(", ")];
  if (blocked.length) previewParts.push(`· skipping ${blocked.length} do-not-contact (${blocked.join(", ")})`);

  emitAction({
    id: actionId,
    type: "enroll_in_sequence",
    title: `Enroll ${people.length} ${people.length === 1 ? "person" : "people"} in ${seq.name}`,
    params: { sequence_id: seq.id, sequence_name: seq.name, people },
    preview: previewParts.join(" "),
    route: null,
    entity_type: "candidate",
  });

  return JSON.stringify({
    proposed: true,
    action_id: actionId,
    awaiting_recruiter_approval: true,
    sequence: seq.name,
    enrolling: names,
    skipped_do_not_contact: blocked,
    unresolved_count: unresolved,
    note: "An approval card is showing. In one line, tell the recruiter who you queued for the sequence (and any do_not_contact you skipped); it enrolls only when they approve. Do NOT claim it is done.",
  });
}

// Build + emit an approve/edit/reject proposal. Never writes to the DB; the
// recruiter's client performs the action only on approval.
async function handleWriteTool(
  supabase: any,
  name: string,
  input: any,
  emitAction: (a: any) => void,
): Promise<string> {
  // enroll_in_sequence has its own multi-person + sequence-resolution path.
  if (name === "enroll_in_sequence") return await handleEnrollProposal(supabase, input, emitAction);

  const outreach = name === "draft_message";
  let person: any = null;
  if (input?.person_id) person = await getPersonBrief(supabase, input.person_id);
  if (outreach && person?.do_not_contact) {
    return JSON.stringify({
      refused: true,
      reason: "Person is marked do_not_contact — outreach is blocked. Do not propose this.",
    });
  }

  const actionId = crypto.randomUUID();
  // Deep-link the recruiter to the right place to confirm, and tell the note
  // path which entity bucket to write to.
  const route = person
    ? person.type === "client"
      ? `/contacts/${person.id}`
      : `/candidates/${person.id}`
    : input?.job_id
      ? `/jobs/${input.job_id}`
      : null;
  const noteEntityType = person?.type === "client" ? "contact" : "candidate";

  let title = "";
  let preview = "";
  switch (name) {
    case "draft_message":
      title = `Draft ${input.channel} to ${personName(person)}`;
      preview = input.purpose ?? "";
      break;
    case "move_pipeline_stage":
      title = `Move ${personName(person)} → ${input.to_stage}`;
      break;
    case "create_task":
      title = `Create task: ${input.title}`;
      preview = input.due_date ? `Due ${input.due_date}` : "";
      break;
    case "add_note":
      title = `Add note to ${personName(person)}`;
      preview = input.note ?? "";
      break;
    default:
      return JSON.stringify({ error: `unknown write tool ${name}` });
  }

  emitAction({
    id: actionId,
    type: name,
    title,
    params: input,
    preview,
    route,
    entity_type: noteEntityType,
  });
  return JSON.stringify({
    proposed: true,
    action_id: actionId,
    awaiting_recruiter_approval: true,
    note: "An approval card was shown to the recruiter. Summarize what you proposed in one short line. Do NOT claim it is done — it only happens if they approve.",
  });
}

async function runTool(
  supabase: any,
  name: string,
  input: any,
  emitAction: (a: any) => void,
): Promise<string> {
  const exec = async (): Promise<string> => {
    if (WRITE_TOOL_NAMES.has(name)) return await handleWriteTool(supabase, name, input, emitAction);
    switch (name) {
      case "search_people": return await toolSearchPeople(supabase, input);
      case "get_person_detail": return await toolGetPersonDetail(supabase, input);
      case "list_recent_communications": return await toolListRecentCommunications(supabase, input);
      case "search_messages": return await toolSearchMessages(supabase, input);
      case "list_notes": return await toolListNotes(supabase, input);
      case "list_send_outs": return await toolListSendOuts(supabase, input);
      case "list_jobs": return await toolListJobs(supabase, input);
      case "get_job_detail": return await toolGetJobDetail(supabase, input);
      case "match_candidates_to_job": return await toolMatchCandidatesToJob(supabase, input);
      case "search_companies": return await toolSearchCompanies(supabase, input);
      case "list_company_people": return await toolListCompanyPeople(supabase, input);
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
  tools: any[],
  emitAction: (a: any) => void,
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
        tools,
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
      const result = await runTool(supabase, tu.name, parsedInput, emitAction);
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
  openaiTools: any[],
  emitAction: (a: any) => void,
): Promise<StreamResult> {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...initialMessages.map(flattenMessage),
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, stream: true, tools: openaiTools, messages }),
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
      const result = await runTool(supabase, c.name!, parsed, emitAction);
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

/**
 * Pull the provider keys from app_settings and prefer them over the Deno.env
 * edge secrets. The Vercel side reads keys from app_settings (getOpenAIKey, …),
 * so that store stays current while the separately-managed edge secrets go
 * stale — which left every Joe turn falling through the cascade to "No provider
 * succeeded". Best-effort: any failure keeps the env values.
 */
async function refreshKeysFromAppSettings(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const ks = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data } = await ks
      .from("app_settings")
      .select("key,value")
      .in("key", ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
    for (const row of data ?? []) {
      const v = String((row as any).value ?? "").trim();
      if (!v) continue;
      if (row.key === "OPENAI_API_KEY") OPENAI_API_KEY = v;
      else if (row.key === "ANTHROPIC_API_KEY") ANTHROPIC_API_KEY = v;
      else if (row.key === "GEMINI_API_KEY") GEMINI_API_KEY = v;
      else if (row.key === "OPENROUTER_API_KEY") OPENROUTER_API_KEY = v;
    }
  } catch (_e) {
    // keep whatever the Deno.env secrets provided
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  await refreshKeysFromAppSettings();

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

  // Agentic write-tools are gated behind JOE_AGENTIC_ENABLED (read via the
  // service role). Off → Joe behaves exactly as before (9 read-only tools).
  let agentic = false;
  try {
    const { data: flag } = await supabase
      .from("app_settings").select("value").eq("key", "JOE_AGENTIC_ENABLED").maybeSingle();
    const raw = String(flag?.value ?? "").trim().toLowerCase();
    agentic = raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  } catch { /* default off */ }

  const systemPrompt = agentic ? BASE_SYSTEM_PROMPT + AGENTIC_PROMPT_SUFFIX : BASE_SYSTEM_PROMPT;
  const tools = agentic ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  const openaiTools = agentic ? toOpenAITools(tools) : OPENAI_TOOLS;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));
      const status = (s: string) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: s })}\n\n`));
      // Additive SSE event: existing clients ignore unknown keys; the action
      // card UI listens for `action`.
      const emitAction = (a: any) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ action: a })}\n\n`));

      try {
        if (OPENAI_API_KEY) {
          const r = await streamOpenAIWithTools(supabase, systemPrompt, messages, send, status, openaiTools, emitAction);
          if (r.ok) return;
          if (!r.fallbackable) { send(`\n\n[Joe error] OpenAI ${r.status}: ${r.body.slice(0, 200)}`); return; }
          console.warn("OpenAI failed, falling back:", r.status);
        }
        if (ANTHROPIC_API_KEY) {
          const r = await streamAnthropicWithTools(supabase, systemPrompt, messages, send, status, tools, emitAction);
          if (r.ok) return;
          if (!r.fallbackable) { send(`\n\n[Joe error] Anthropic ${r.status}: ${r.body.slice(0, 200)}`); return; }
          console.warn("Anthropic failed, falling back:", r.status);
        }
        if (GEMINI_API_KEY) {
          const r = await streamGeminiOneShot(systemPrompt, messages, send);
          if (r.ok) return;
          if (!r.fallbackable) { send(`\n\n[Joe error] Gemini ${r.status}: ${r.body.slice(0, 200)}`); return; }
        }
        if (OPENROUTER_API_KEY) {
          const r = await streamOpenRouter(systemPrompt, messages, send);
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
