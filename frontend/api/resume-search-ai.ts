import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createSupabaseAdmin,
  enrichMatches,
  searchResumeEmbeddings,
} from "./lib/voyage";

/**
 * POST /api/resume-search-ai
 * Multi-turn AI chat that searches the resume database via Voyage + pgvector.
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

    const supabase = createSupabaseAdmin();
    const matches = await searchResumeEmbeddings(supabase, query, 20);
    const enriched = await enrichMatches(supabase, matches);

    const contextBlock = enriched.length > 0
      ? enriched.slice(0, 20).map((c) => {
          return `### ${c.full_name || "Unknown"}\n- Title: ${c.current_title || "?"} at ${c.current_company || "?"}\n- Location: ${c.location || "?"}\n- Status: ${c.status || "?"}\n- Match score: ${((c.match.similarity || 0) * 100).toFixed(0)}%\n- Resume excerpt:\n  > ${(c.match.content || "").slice(0, 400)}`;
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

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (Array.isArray(messages)) {
      for (const msg of messages.slice(-10)) {
        if ((msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string") {
          history.push({ role: msg.role, content: msg.content });
        }
      }
    }
    if (!history.length || history[history.length - 1].role !== "user") {
      history.push({ role: "user", content: query });
    }

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
        messages: history,
      }),
    });

    if (!claudeResp.ok) {
      writeError(`Claude API error: ${await claudeResp.text()}`);
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
            // skip malformed lines
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
