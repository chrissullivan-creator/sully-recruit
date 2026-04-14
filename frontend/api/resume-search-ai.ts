import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  VoyageEmbedding,
  retrieveResumeChunks,
  chunksToNodes,
  createSupabaseAdmin,
} from "./lib/llamaindex";
import { Anthropic } from "@llamaindex/anthropic";

/**
 * POST /api/resume-search-ai
 * Multi-turn AI chat that searches the resume database.
 * Uses LlamaIndex.TS with Voyage embeddings + pgvector retrieval + Anthropic synthesis.
 * Streams SSE responses with data.content chunks.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const voyageKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const write = (content: string) => {
    res.write(`data: ${JSON.stringify({ content })}\n\n`);
  };
  const writeError = (error: string) => {
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
  };

  try {
    const { query, messages } = req.body;

    if (!query) {
      writeError("Missing query");
      return res.end();
    }

    const supabase = createSupabaseAdmin();
    let resumeContext = "";

    // ── LlamaIndex RAG: Embed → Retrieve → Format ──────────────────
    if (voyageKey) {
      try {
        const embedModel = new VoyageEmbedding(voyageKey);
        const queryEmbedding = await embedModel.getQueryEmbedding(query);

        const chunks = await retrieveResumeChunks(supabase, queryEmbedding, 50, 0.3);

        if (chunks.length > 0) {
          // Deduplicate by candidate_id and load metadata
          const seen = new Map<string, string[]>();
          for (const chunk of chunks) {
            if (!chunk.candidate_id) continue;
            const existing = seen.get(chunk.candidate_id) || [];
            existing.push(chunk.content?.slice(0, 400) || "");
            seen.set(chunk.candidate_id, existing);
          }

          const topIds = Array.from(seen.keys()).slice(0, 20);
          const { data: candidates } = await supabase
            .from("candidates")
            .select("id, full_name, current_title, current_company, location, email, phone, status")
            .in("id", topIds);

          if (candidates?.length) {
            resumeContext = candidates
              .map((c) => {
                const excerpts = seen.get(c.id);
                return `### ${c.full_name}\n- Title: ${c.current_title || "?"} at ${c.current_company || "?"}\n- Location: ${c.location || "?"}\n- Status: ${c.status}\n- Resume excerpts:\n${excerpts?.map((e) => `  > ${e}`).join("\n") || "  N/A"}`;
              })
              .join("\n\n");
          }
        }
      } catch {
        // Fall through to text search
      }
    }

    // ── Fallback: text search on candidates table ───────────────────
    if (!resumeContext) {
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
        resumeContext = candidates
          .map((c) => `### ${c.full_name}\n- ${c.current_title || "?"} at ${c.current_company || "?"}\n- Location: ${c.location || "?"}\n- Status: ${c.status}${c.joe_says ? `\n- Summary: ${(c.joe_says as string).slice(0, 300)}` : ""}`)
          .join("\n\n");
      }
    }

    // ── LlamaIndex Anthropic LLM: Streaming synthesis ───────────────
    const systemPrompt = `You are Joe, the AI recruiting assistant at Sully Recruit (The Emerald Recruiting Group). You help search and analyze candidate resumes in the database.

When answering:
- Be specific about candidates found — include names, titles, companies
- Reference resume details when available
- Be direct and opinionated about fit
- If no relevant candidates found, say so clearly

${resumeContext ? `## Resume Database Search Results\n\n${resumeContext}` : "No matching resumes found in the database for this query."}`;

    const conversationMessages = (messages || [])
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m: any) => ({ role: m.role, content: m.content }));

    if (!conversationMessages.length || conversationMessages[conversationMessages.length - 1].role !== "user") {
      conversationMessages.push({ role: "user", content: query });
    }

    // Stream via raw Anthropic API (LlamaIndex.TS chat streaming uses
    // the same underlying SDK; we stream SSE for frontend compatibility)
    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages: conversationMessages,
      }),
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      writeError(`Claude API error: ${errText}`);
      return res.end();
    }

    const reader = claudeResp.body?.getReader();
    if (!reader) {
      writeError("No response stream");
      return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "content_block_delta" && event.delta?.text) {
              write(event.delta.text);
            }
          } catch {
            // skip
          }
        }
      }
    }

    res.end();
  } catch (err: any) {
    console.error("resume-search-ai error:", err.message);
    writeError(err.message);
    res.end();
  }
}
