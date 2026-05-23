import type { SupabaseClient } from "@supabase/supabase-js";
import { embedQuery } from "./voyage.js";

export interface BrainSearchHit {
  id: string;
  kind: string;
  source_id: string | null;
  role_context: string | null;
  title: string | null;
  subtitle: string | null;
  body: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
  score: number;
  matched_via: "semantic" | "keyword" | "both";
}

// search_documents is ~5% embedded today — FTS does most of the work.
// We still run both and fuse with Reciprocal Rank Fusion so semantic
// hits surface to the top of the result list when they exist.
const RRF_K = 60;

export async function hybridSearch(
  supabase: SupabaseClient,
  query: string,
  opts: { kinds?: string[]; limit?: number } = {},
): Promise<BrainSearchHit[]> {
  const text = String(query ?? "").trim().slice(0, 600);
  if (!text) return [];

  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
  const filterKinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : null;
  const overFetch = limit * 3;

  const [fts, semantic] = await Promise.all([
    runFts(supabase, text, filterKinds, overFetch),
    runSemantic(supabase, text, filterKinds, overFetch),
  ]);

  const fused = new Map<string, BrainSearchHit>();

  fts.forEach((row, rank) => {
    fused.set(row.id, { ...row, score: 1 / (RRF_K + rank + 1), matched_via: "keyword" });
  });

  semantic.forEach((row, rank) => {
    const prior = fused.get(row.id);
    const sem = 1 / (RRF_K + rank + 1);
    if (prior) {
      fused.set(row.id, { ...prior, score: prior.score + sem, matched_via: "both" });
    } else {
      fused.set(row.id, { ...row, score: sem, matched_via: "semantic" });
    }
  });

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function runFts(
  supabase: SupabaseClient,
  query: string,
  filterKinds: string[] | null,
  matchCount: number,
): Promise<BrainSearchHit[]> {
  const { data, error } = await supabase.rpc("search_search_documents", {
    search_query: query,
    filter_kinds: filterKinds,
    match_count: matchCount,
  });
  if (error || !data) return [];
  return (data as any[]).map((r) => mapRow(r, Number(r.score ?? 0)));
}

async function runSemantic(
  supabase: SupabaseClient,
  query: string,
  filterKinds: string[] | null,
  matchCount: number,
): Promise<BrainSearchHit[]> {
  try {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_search_documents", {
      query_embedding: embedding,
      filter_kinds: filterKinds,
      match_count: matchCount,
      min_similarity: 0.22,
    });
    if (error || !data) return [];
    return (data as any[]).map((r) => mapRow(r, Number(r.similarity ?? 0)));
  } catch {
    return [];
  }
}

function mapRow(r: any, score: number): BrainSearchHit {
  const body = typeof r.body === "string" ? r.body.slice(0, 600) : null;
  return {
    id: String(r.id),
    kind: String(r.source_kind ?? "unknown"),
    source_id: r.source_id ?? null,
    role_context: r.role_context ?? null,
    title: r.title ?? null,
    subtitle: r.subtitle ?? null,
    body,
    url: r.url ?? null,
    metadata: r.metadata ?? null,
    score,
    matched_via: "keyword",
  };
}
