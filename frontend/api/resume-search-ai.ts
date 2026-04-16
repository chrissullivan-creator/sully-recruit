import type { VercelRequest, VercelResponse } from "@vercel/node";
import { searchResumes } from "./lib/llamaindex";

/**
 * POST /api/resume-search-ai
 * Multi-turn AI chat that searches the resume database via LlamaCloud + Claude.
 * No Voyage dependency — all retrieval goes through LlamaCloud managed pipeline.
 * Streams SSE responses with data.content chunks.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
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

    write("Searching candidate database...\n\n");

    // LlamaCloud-powered search with Claude synthesis
    const result = await searchResumes(query, {
      topK: 20,
      conversationHistory: messages,
    });

    // Stream the response in chunks for smooth SSE delivery
    const text = result.response;
    const chunkSize = 20;
    for (let i = 0; i < text.length; i += chunkSize) {
      write(text.slice(i, i + chunkSize));
    }

    res.end();
  } catch (err: any) {
    console.error("resume-search-ai error:", err.message);
    writeError(err.message);
    res.end();
  }
}
