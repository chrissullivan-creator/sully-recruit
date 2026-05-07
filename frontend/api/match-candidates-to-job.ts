import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createSupabaseAdmin,
  enrichMatches,
  searchResumeEmbeddings,
} from "./lib/voyage";
import { requireAuth } from "./lib/auth";

/**
 * POST /api/match-candidates-to-job
 * Streams candidate match results for a job using Voyage + pgvector retrieval
 * and Claude scoring. SSE response with data.content chunks.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

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
    const { job_title, job_company, job_location, job_description, job_salary } = req.body;

    if (!job_title) {
      writeError("Missing job_title");
      return res.end();
    }

    const supabase = createSupabaseAdmin();

    write("Searching candidate database...\n\n");

    const jobContext = [
      `Title: ${job_title}`,
      job_company && `Company: ${job_company}`,
      job_location && `Location: ${job_location}`,
      job_salary && `Compensation: ${job_salary}`,
      job_description && `Description: ${job_description.slice(0, 2000)}`,
    ].filter(Boolean).join("\n");

    const searchText = `${job_title} ${job_company || ""} ${job_description || ""}`.slice(0, 4000);
    const matches = await searchResumeEmbeddings(supabase, searchText, 30);
    const enriched = await enrichMatches(supabase, matches);

    if (enriched.length === 0) {
      write("No matching candidates found in the database.\n");
      return res.end();
    }

    write(`Found ${enriched.length} potential matches. Analyzing...\n\n`);

    const candidateContext = enriched
      .map((c) => {
        return `- ${c.full_name || "Unknown"} | ${c.current_title || "?"} at ${c.current_company || "?"} | ${c.location || "?"} | Status: ${c.status || "?"}\n  Resume excerpt: ${(c.match.content || "").slice(0, 300)}`;
      })
      .join("\n");

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
        messages: [
          {
            role: "user",
            content: `You are Joe, the AI backbone of Sully Recruit — a Wall Street recruiting CRM. Rank these candidates for the following role. Be specific about why each is a good or poor fit.

## Job
${jobContext}

## Candidates
${candidateContext}

Rank the top candidates from best to worst fit. For each candidate provide:
1. **Name** — Current Title at Company
2. **Fit Score**: X/100
3. **Why**: 1-2 sentences on strengths and concerns
4. **Status**: their current pipeline status

Be direct and opinionated. Skip candidates that are clearly not a fit.`,
          },
        ],
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
    console.error("match-candidates-to-job error:", err.message);
    writeError(err.message);
    res.end();
  }
}
