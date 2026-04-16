/**
 * LlamaIndex.TS + LlamaCloud integration for Sully Recruit.
 *
 * All search goes through LlamaCloud managed pipelines — no Voyage dependency.
 *
 * Provides:
 * - LlamaCloud pipeline management (create, upload, retrieve)
 * - Resume search via LlamaCloud retrieval
 * - Job-candidate matching via LlamaCloud retrieval + Claude scoring
 * - Anthropic LLM for synthesis
 */
import {
  TextNode,
  NodeWithScore,
  type MessageContent,
} from "llamaindex";
import { Anthropic } from "@llamaindex/anthropic";
import {
  client as llamaCloudClient,
  createPipelineApiV1PipelinesPost,
  runSearchApiV1PipelinesPipelineIdRetrievePost,
  listPipelinesApiV1PipelinesGet,
  createBatchPipelineDocumentsApiV1PipelinesPipelineIdDocumentsPost,
} from "@llamaindex/cloud/api";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
// LlamaCloud Client Configuration
// ─────────────────────────────────────────────────────────────────────────────

let cloudConfigured = false;

function ensureCloudClient() {
  if (cloudConfigured) return;
  const apiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!apiKey) throw new Error("LLAMA_CLOUD_API_KEY not configured");

  llamaCloudClient.setConfig({
    baseUrl: "https://api.cloud.llamaindex.ai",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  cloudConfigured = true;
}

// Pipeline name for the resume index
const RESUME_PIPELINE_NAME = "sully-recruit-resumes";

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Management
// ─────────────────────────────────────────────────────────────────────────────

let cachedPipelineId: string | null = null;

/**
 * Get or create the LlamaCloud pipeline for resume search.
 * Caches the pipeline ID in memory for the lifetime of the serverless function.
 */
export async function getOrCreateResumePipeline(): Promise<string> {
  if (cachedPipelineId) return cachedPipelineId;
  ensureCloudClient();

  // Check if pipeline already exists
  const { data: pipelines } = await listPipelinesApiV1PipelinesGet({
    query: { project_name: "Default" },
  });

  const existing = (pipelines as any[])?.find(
    (p: any) => p.name === RESUME_PIPELINE_NAME,
  );

  if (existing) {
    cachedPipelineId = existing.id;
    return existing.id;
  }

  // Create new pipeline optimized for resume search
  const { data: pipeline } = await createPipelineApiV1PipelinesPost({
    body: {
      name: RESUME_PIPELINE_NAME,
      pipeline_type: "MANAGED",
      embedding_config: {
        type: "OPENAI_EMBEDDING",
        component: {
          api_key: "default", // LlamaCloud manages this
          model_name: "text-embedding-3-small",
        },
      },
      transform_config: {
        mode: "auto",
        chunk_size: 512,
        chunk_overlap: 50,
      },
    } as any,
  });

  cachedPipelineId = (pipeline as any).id;
  return cachedPipelineId!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Upload to LlamaCloud
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload resume text chunks to LlamaCloud pipeline.
 * Each chunk becomes a document with candidate metadata.
 */
export async function uploadResumeToCloud(
  pipelineId: string,
  candidateId: string,
  resumeId: string,
  chunks: string[],
  candidateName?: string,
): Promise<void> {
  ensureCloudClient();

  const documents = chunks.map((chunk, i) => ({
    text: chunk,
    metadata: {
      candidate_id: candidateId,
      resume_id: resumeId,
      chunk_index: i,
      candidate_name: candidateName || "",
      source: "sully-recruit",
    },
    id_: `${resumeId}-chunk-${i}`,
  }));

  await createBatchPipelineDocumentsApiV1PipelinesPipelineIdDocumentsPost({
    path: { pipeline_id: pipelineId },
    body: documents as any,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LlamaCloud Retrieval
// ─────────────────────────────────────────────────────────────────────────────

export interface CloudRetrievalResult {
  text: string;
  score: number;
  metadata: Record<string, any>;
}

/**
 * Search resumes via LlamaCloud's managed retrieval.
 * Uses hybrid search (dense + sparse) with reranking for best results.
 */
export async function retrieveFromCloud(
  pipelineId: string,
  query: string,
  topK = 20,
): Promise<CloudRetrievalResult[]> {
  ensureCloudClient();

  const { data } = await runSearchApiV1PipelinesPipelineIdRetrievePost({
    path: { pipeline_id: pipelineId },
    body: {
      query,
      dense_similarity_top_k: topK,
      sparse_similarity_top_k: topK,
      enable_reranking: true,
      rerank_top_n: Math.min(topK, 20),
      alpha: 0.7, // Favor dense (semantic) over sparse (keyword)
    } as any,
  });

  const results = (data as any)?.retrieval_nodes || [];
  return results.map((node: any) => ({
    text: node.node?.text || node.text || "",
    score: node.score || 0,
    metadata: node.node?.metadata || node.metadata || {},
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback: Supabase pgvector (for when LlamaCloud is unavailable)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeChunkResult {
  id: string;
  resume_id: string;
  candidate_id: string;
  content: string;
  similarity: number;
}

export async function fallbackTextSearch(
  supabase: SupabaseClient,
  query: string,
  limit = 20,
): Promise<ResumeChunkResult[]> {
  const keywords = query.split(/\s+/).slice(0, 3);
  const orFilter = keywords
    .map((k: string) => `full_name.ilike.%${k}%,current_title.ilike.%${k}%,current_company.ilike.%${k}%`)
    .join(",");

  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, full_name, current_title, current_company, location, status, joe_says")
    .or(orFilter)
    .limit(limit);

  return (candidates || []).map((c) => ({
    id: c.id,
    resume_id: "",
    candidate_id: c.id,
    content: `${c.full_name}: ${c.current_title || "?"} at ${c.current_company || "?"}. Location: ${c.location || "?"}. Status: ${c.status}${c.joe_says ? `. Summary: ${(c.joe_says as string).slice(0, 300)}` : ""}`,
    similarity: 0.5,
  }));
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
// Full RAG Pipeline: Search resumes with LlamaCloud + Claude
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
    conversationHistory?: Array<{ role: string; content: string }>;
  },
): Promise<RAGSearchResult> {
  const supabase = createSupabaseAdmin();
  const topK = options?.topK || 20;

  let sourceNodes: NodeWithScore[] = [];
  let candidateIds: string[] = [];

  // Step 1: Try LlamaCloud retrieval
  try {
    const pipelineId = await getOrCreateResumePipeline();
    const cloudResults = await retrieveFromCloud(pipelineId, query, topK);

    if (cloudResults.length > 0) {
      // Deduplicate by candidate_id
      const seen = new Map<string, CloudRetrievalResult[]>();
      for (const result of cloudResults) {
        const candId = result.metadata?.candidate_id;
        if (!candId) continue;
        const existing = seen.get(candId) || [];
        existing.push(result);
        seen.set(candId, existing);
      }

      candidateIds = [...seen.keys()];

      // Load candidate metadata from Supabase
      const { data: candidates } = await supabase
        .from("candidates")
        .select("id, full_name, current_title, current_company, location, email, phone, status")
        .in("id", candidateIds.slice(0, 20));

      const candidateMap = new Map((candidates || []).map((c) => [c.id, c]));

      // Convert to LlamaIndex nodes
      sourceNodes = cloudResults.map((result) => {
        const candidate = candidateMap.get(result.metadata?.candidate_id);
        const node = new TextNode({
          text: result.text,
          id_: result.metadata?.candidate_id || "",
          metadata: {
            candidate_id: result.metadata?.candidate_id || "",
            resume_id: result.metadata?.resume_id || "",
            candidate_name: candidate?.full_name || result.metadata?.candidate_name || "Unknown",
            current_title: candidate?.current_title || "",
            current_company: candidate?.current_company || "",
            location: candidate?.location || "",
            status: candidate?.status || "",
          },
        });
        return { node, score: result.score };
      });
    }
  } catch (err) {
    console.warn("LlamaCloud retrieval failed, falling back to text search:", (err as Error).message);
  }

  // Step 2: Fallback to text search if no cloud results
  if (sourceNodes.length === 0) {
    const fallbackResults = await fallbackTextSearch(supabase, query);
    candidateIds = fallbackResults.map((r) => r.candidate_id);
    sourceNodes = fallbackResults.map((r) => ({
      node: new TextNode({
        text: r.content,
        id_: r.id,
        metadata: {
          candidate_id: r.candidate_id,
          candidate_name: r.content.split(":")[0] || "Unknown",
          current_title: "",
          current_company: "",
          location: "",
          status: "",
        },
      }),
      score: r.similarity,
    }));
  }

  // Step 3: Synthesize response with Claude
  const llm = createAnthropicLLM();

  const contextBlock = sourceNodes.length > 0
    ? sourceNodes.slice(0, 20).map((ns) => {
        const m = ns.node.metadata;
        const excerpts = ns.node.getContent();
        return `### ${m.candidate_name}\n- Title: ${m.current_title || "?"} at ${m.current_company || "?"}\n- Location: ${m.location || "?"}\n- Status: ${m.status}\n- Match score: ${((ns.score || 0) * 100).toFixed(0)}%\n- Resume excerpt:\n  > ${excerpts.slice(0, 400)}`;
      }).join("\n\n")
    : "No matching candidates found in the database for this query.";

  const systemPrompt = `You are Joe, the AI recruiting assistant at Sully Recruit (The Emerald Recruiting Group), a Wall Street recruiting firm specializing in financial services placements.

When answering:
- Be specific about candidates found — include names, titles, companies
- Reference resume details when available
- Be direct and opinionated about fit for Wall Street / financial services roles
- Evaluate candidates through a finance industry lens (certifications, firm prestige, deal experience, etc.)
- If no relevant candidates found, say so clearly

## Resume Database Search Results

${contextBlock}`;

  const messages: Array<{ role: "user" | "assistant"; content: MessageContent }> = [];

  if (options?.conversationHistory?.length) {
    for (const msg of options.conversationHistory.slice(-10)) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
      }
    }
  }

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
