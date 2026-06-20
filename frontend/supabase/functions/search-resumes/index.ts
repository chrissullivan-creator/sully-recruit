import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Embeddings still use OpenAI (Claude has no embedding API)
const OPENAI_API_KEY =
  Deno.env.get("OPENAI_API_KEY") ??
  Deno.env.get("openai_api_key") ??
  "";
// Reranking / scoring uses Claude
const ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??
  "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { query } = await req.json();
    if (!query?.trim()) throw new Error("query required");

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1. Embed the query with OpenAI (only embeddings API available from OpenAI)
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured (required for embeddings)");

    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-large", input: query.slice(0, 8000) }),
    });
    if (!embedRes.ok) throw new Error(`OpenAI embedding error: ${await embedRes.text()}`);
    const embedData = await embedRes.json();
    const embedding = embedData.data?.[0]?.embedding;
    if (!embedding) throw new Error("Failed to generate embedding");

    // 2. Semantic search via pgvector
    const { data: embeddingMatches, error: embErr } = await sb.rpc("search_resumes_by_embedding", {
      query_embedding: embedding,
      match_threshold: 0.25,
      match_count: 20,
    });
    if (embErr) console.warn("Embedding search error:", embErr.message);

    const semanticIds = (embeddingMatches ?? []).map((r: any) => r.candidate_id);
    const scoreMap = new Map((embeddingMatches ?? []).map((r: any) => [r.candidate_id, r.similarity ?? r.score ?? 0]));

    // 3. Fetch candidates
    const { data: allCandidates } = await sb.from("candidates")
      .select("id, full_name, first_name, last_name, current_title, current_company, location_text, resume_url, joe_says, status, job_status")
      .order("updated_at", { ascending: false })
      .limit(100);

    const candidates = allCandidates ?? [];
    const semantic = semanticIds
      .map((id: string) => candidates.find((c: any) => c.id === id))
      .filter(Boolean);
    const withResume = candidates.filter((c: any) => c.resume_url && !semanticIds.includes(c.id));
    const rest = candidates.filter((c: any) => !c.resume_url && !semanticIds.includes(c.id));
    const merged = [...semantic, ...withResume, ...rest].slice(0, 30);

    // 4. Use Claude to score and explain matches
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

    const candidateList = merged.map((c: any, i: number) => {
      const score = scoreMap.get(c.id);
      return `${i + 1}. ID:${c.id} | ${c.full_name} | ${c.current_title ?? ""} @ ${c.current_company ?? ""} | ${c.location_text ?? ""} | ${score ? `semantic_score:${score.toFixed(3)}` : c.resume_url ? "has_resume" : "no_resume"}${c.joe_says ? ` | Joe Says: ${c.joe_says.slice(0, 200)}` : ""}`;
    }).join("\n");

    const claudeRes = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: `You are Joe, a Wall Street recruiting assistant for The Emerald Recruiting Group. Rank and score candidates against a search query. Return ONLY a valid JSON array — no markdown, no explanation, no backticks.`,
        messages: [
          {
            role: "user",
            content: `A recruiter searched for: "${query}"

Here are the candidates. Return the top 10 best matches as a JSON array. Prioritize semantic matches and candidates with resumes.

For each match return:
{
  "id": "<candidate id>",
  "full_name": "<name>",
  "current_title": "<title>",
  "current_company": "<company>",
  "location": "<location>",
  "relevance_score": <0.0-1.0>,
  "match_reasons": ["<reason1>", "<reason2>"],
  "skills": ["<skill1>", "<skill2>"]
}

CANDIDATES:
${candidateList}`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) throw new Error(`Claude error: ${await claudeRes.text()}`);
    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text?.trim() ?? "[]";

    let results: any[] = [];
    try {
      results = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      results = [];
    }

    return new Response(JSON.stringify({ success: true, results, total: results.length }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[search-resumes] error:", err.message);
    return new Response(JSON.stringify({ success: false, error: err.message, results: [] }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
