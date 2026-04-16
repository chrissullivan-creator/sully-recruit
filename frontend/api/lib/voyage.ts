import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const VOYAGE_MODEL = "voyage-finance-2";

export function createSupabaseAdmin(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function embedQuery(text: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY not configured");

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text.slice(0, 8000)],
      input_type: "query",
    }),
  });

  if (!res.ok) {
    throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

export interface ResumeMatch {
  candidate_id: string;
  resume_id: string | null;
  content: string;
  similarity: number;
}

/**
 * Vector-search the resume_embeddings table (Voyage voyage-finance-2, 1024-dim).
 * Deduplicates by candidate_id, keeping the best similarity.
 * Falls back to text search over candidates when no vector matches.
 */
export async function searchResumeEmbeddings(
  supabase: SupabaseClient,
  query: string,
  topK = 20,
): Promise<ResumeMatch[]> {
  try {
    const embedding = await embedQuery(query);

    const { data, error } = await supabase.rpc("match_resume_embeddings", {
      query_embedding: embedding,
      match_count: topK * 3,
      min_similarity: 0.3,
    });

    if (!error && data?.length) {
      const seen = new Map<string, ResumeMatch>();
      for (const row of data as any[]) {
        const candId = row.candidate_id;
        if (!candId) continue;
        const prev = seen.get(candId);
        if (!prev || (row.similarity ?? 0) > prev.similarity) {
          seen.set(candId, {
            candidate_id: candId,
            resume_id: row.resume_id ?? null,
            content: row.chunk_text || row.source_text || "",
            similarity: row.similarity ?? 0,
          });
        }
      }
      return [...seen.values()]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
    }
  } catch (err) {
    console.warn("Voyage/pgvector search failed:", (err as Error).message);
  }

  return fallbackTextSearch(supabase, query, topK);
}

export async function fallbackTextSearch(
  supabase: SupabaseClient,
  query: string,
  limit = 20,
): Promise<ResumeMatch[]> {
  const keywords = query.split(/\s+/).filter(Boolean).slice(0, 3);
  if (keywords.length === 0) return [];

  const orFilter = keywords
    .map((k) =>
      `full_name.ilike.%${k}%,current_title.ilike.%${k}%,current_company.ilike.%${k}%`,
    )
    .join(",");

  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, full_name, current_title, current_company, location, status, joe_says")
    .or(orFilter)
    .limit(limit);

  return (candidates || []).map((c: any) => ({
    candidate_id: c.id,
    resume_id: null,
    content: `${c.full_name}: ${c.current_title || "?"} at ${c.current_company || "?"}. Location: ${c.location || "?"}. Status: ${c.status}${c.joe_says ? `. Summary: ${(c.joe_says as string).slice(0, 300)}` : ""}`,
    similarity: 0.5,
  }));
}

export interface EnrichedCandidate {
  id: string;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  joe_says: string | null;
  match: ResumeMatch;
}

export async function enrichMatches(
  supabase: SupabaseClient,
  matches: ResumeMatch[],
): Promise<EnrichedCandidate[]> {
  if (matches.length === 0) return [];
  const ids = matches.map((m) => m.candidate_id);

  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, full_name, current_title, current_company, location, email, phone, status, joe_says")
    .in("id", ids);

  const byId = new Map((candidates || []).map((c: any) => [c.id, c]));

  return matches
    .map((m) => {
      const c = byId.get(m.candidate_id);
      if (!c) return null;
      return { ...(c as any), match: m } as EnrichedCandidate;
    })
    .filter(Boolean) as EnrichedCandidate[];
}
