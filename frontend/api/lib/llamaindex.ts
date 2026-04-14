/**
 * LlamaIndex.TS integration for Sully Recruit.
 *
 * Provides:
 * - VoyageEmbedding: Custom embedding class using Voyage Finance-2 (1024 dims)
 * - ResumeRetriever: Custom retriever that queries resume_chunks via Supabase pgvector
 * - createResumeQueryEngine: Builds a LlamaIndex query engine for resume search
 * - createCandidateRetriever: Retriever for job-candidate matching
 */
import {
  BaseEmbedding,
  VectorStoreIndex,
  TextNode,
  NodeWithScore,
  type MessageContent,
} from "llamaindex";
import { Anthropic } from "@llamaindex/anthropic";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
// Voyage Finance-2 Embedding (1024 dims, matches existing resume_chunks)
// ─────────────────────────────────────────────────────────────────────────────

export class VoyageEmbedding extends BaseEmbedding {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = "voyage-finance-2") {
    super();
    this.apiKey = apiKey;
    this.model = model;
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    return this.embed(text, "document");
  }

  async getQueryEmbedding(query: string): Promise<number[]> {
    return this.embed(query, "query");
  }

  async getTextEmbeddings(texts: string[]): Promise<number[][]> {
    // Voyage supports batch embedding
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts.map((t) => t.slice(0, 4000)),
        input_type: "document",
      }),
    });

    if (!resp.ok) {
      throw new Error(`Voyage API error: ${await resp.text()}`);
    }

    const data = await resp.json();
    return data.data.map((d: any) => d.embedding);
  }

  private async embed(text: string, inputType: "query" | "document"): Promise<number[]> {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text.slice(0, 4000),
        input_type: inputType,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Voyage API error: ${await resp.text()}`);
    }

    const data = await resp.json();
    return data.data?.[0]?.embedding;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume Chunk Retriever (uses existing Supabase pgvector match_resume_chunks)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeChunkResult {
  id: string;
  resume_id: string;
  candidate_id: string;
  content: string;
  similarity: number;
}

export async function retrieveResumeChunks(
  supabase: SupabaseClient,
  queryEmbedding: number[],
  topK = 50,
  minSimilarity = 0.3,
): Promise<ResumeChunkResult[]> {
  const { data: chunks, error } = await supabase.rpc("match_resume_chunks", {
    query_embedding: queryEmbedding,
    match_count: topK,
    min_similarity: minSimilarity,
  });

  if (error) throw new Error(`pgvector search error: ${error.message}`);
  return chunks || [];
}

/**
 * Convert retrieved resume chunks into LlamaIndex TextNodes with candidate metadata.
 */
export function chunksToNodes(
  chunks: ResumeChunkResult[],
  candidates: Map<string, any>,
): NodeWithScore[] {
  return chunks.map((chunk) => {
    const candidate = candidates.get(chunk.candidate_id);
    const node = new TextNode({
      text: chunk.content,
      id_: chunk.id,
      metadata: {
        candidate_id: chunk.candidate_id,
        resume_id: chunk.resume_id,
        candidate_name: candidate?.full_name || "Unknown",
        current_title: candidate?.current_title || "",
        current_company: candidate?.current_company || "",
        location: candidate?.location || "",
        status: candidate?.status || "",
      },
    });
    return { node, score: chunk.similarity };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: Create Supabase client for API routes
// ─────────────────────────────────────────────────────────────────────────────

export function createSupabaseAdmin(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory: Create Anthropic LLM
// ─────────────────────────────────────────────────────────────────────────────

export function createAnthropicLLM(): Anthropic {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-sonnet-4-20250514",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Full RAG Pipeline: Search resumes with LlamaIndex
// ─────────────────────────────────────────────────────────────────────────────

export interface RAGSearchResult {
  response: string;
  sourceNodes: NodeWithScore[];
  candidateIds: string[];
}

export async function searchResumes(
  query: string,
  options?: {
    topK?: number;
    minSimilarity?: number;
    conversationHistory?: Array<{ role: string; content: string }>;
  },
): Promise<RAGSearchResult> {
  const supabase = createSupabaseAdmin();
  const voyageKey = process.env.VOYAGE_API_KEY;
  const topK = options?.topK || 50;
  const minSimilarity = options?.minSimilarity || 0.3;

  let sourceNodes: NodeWithScore[] = [];
  let candidateIds: string[] = [];

  // Step 1: Embed query with Voyage
  if (voyageKey) {
    const embedModel = new VoyageEmbedding(voyageKey);
    const queryEmbedding = await embedModel.getQueryEmbedding(query);

    // Step 2: Retrieve matching chunks via pgvector
    const chunks = await retrieveResumeChunks(supabase, queryEmbedding, topK, minSimilarity);

    if (chunks.length > 0) {
      // Step 3: Load candidate metadata
      const uniqueCandIds = [...new Set(chunks.map((c) => c.candidate_id))];
      candidateIds = uniqueCandIds;

      const { data: candidates } = await supabase
        .from("candidates")
        .select("id, full_name, current_title, current_company, location, email, phone, status")
        .in("id", uniqueCandIds.slice(0, 20));

      const candidateMap = new Map((candidates || []).map((c) => [c.id, c]));

      // Step 4: Convert to LlamaIndex nodes
      sourceNodes = chunksToNodes(chunks, candidateMap);
    }
  }

  // Step 5: Fallback to text search if no vector results
  if (sourceNodes.length === 0) {
    const keywords = query.split(/\s+/).slice(0, 3);
    const orFilter = keywords
      .map((k: string) => `full_name.ilike.%${k}%,current_title.ilike.%${k}%,current_company.ilike.%${k}%`)
      .join(",");

    const { data: candidates } = await supabase
      .from("candidates")
      .select("id, full_name, current_title, current_company, location, status, joe_says")
      .or(orFilter)
      .limit(20);

    if (candidates?.length) {
      candidateIds = candidates.map((c) => c.id);
      sourceNodes = candidates.map((c) => ({
        node: new TextNode({
          text: `${c.full_name}: ${c.current_title || "?"} at ${c.current_company || "?"}. Location: ${c.location || "?"}. Status: ${c.status}${c.joe_says ? `. Summary: ${(c.joe_says as string).slice(0, 300)}` : ""}`,
          id_: c.id,
          metadata: {
            candidate_id: c.id,
            candidate_name: c.full_name,
            current_title: c.current_title || "",
            current_company: c.current_company || "",
            location: c.location || "",
            status: c.status,
          },
        }),
        score: 0.5,
      }));
    }
  }

  // Step 6: Synthesize response with Anthropic via LlamaIndex
  const llm = createAnthropicLLM();

  const contextBlock = sourceNodes.length > 0
    ? sourceNodes.slice(0, 20).map((ns) => {
        const m = ns.node.metadata;
        const excerpts = ns.node.getContent();
        return `### ${m.candidate_name}\n- Title: ${m.current_title || "?"} at ${m.current_company || "?"}\n- Location: ${m.location || "?"}\n- Status: ${m.status}\n- Match score: ${(ns.score * 100).toFixed(0)}%\n- Resume excerpt:\n  > ${excerpts.slice(0, 400)}`;
      }).join("\n\n")
    : "No matching candidates found in the database for this query.";

  const systemPrompt = `You are Joe, the AI recruiting assistant at Sully Recruit (The Emerald Recruiting Group). You help search and analyze candidate resumes in the database.

When answering:
- Be specific about candidates found — include names, titles, companies
- Reference resume details when available
- Be direct and opinionated about fit
- If no relevant candidates found, say so clearly

## Resume Database Search Results

${contextBlock}`;

  const messages: Array<{ role: "user" | "assistant"; content: MessageContent }> = [];

  // Add conversation history if provided
  if (options?.conversationHistory?.length) {
    for (const msg of options.conversationHistory.slice(-10)) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
      }
    }
  }

  // Ensure last message is from user
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: query });
  }

  const response = await llm.chat({
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content as string,
    })),
    additionalChatOptions: {
      system: systemPrompt,
    },
  });

  return {
    response: typeof response.message.content === "string"
      ? response.message.content
      : (response.message.content as any[]).map((c: any) => c.text || "").join(""),
    sourceNodes,
    candidateIds,
  };
}
