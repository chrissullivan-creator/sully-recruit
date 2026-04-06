import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/match-candidates-to-job
 * Streams candidate match results for a job using vector search + Claude scoring.
 * Response format: SSE with data.content chunks.
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
    const { job_title, job_company, job_location, job_description, job_salary } = req.body;

    if (!job_title) {
      writeError("Missing job_title");
      return res.end();
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    write("Searching candidate database...\n\n");

    // Build job context for matching
    const jobContext = [
      `Title: ${job_title}`,
      job_company && `Company: ${job_company}`,
      job_location && `Location: ${job_location}`,
      job_salary && `Compensation: ${job_salary}`,
      job_description && `Description: ${job_description.slice(0, 2000)}`,
    ].filter(Boolean).join("\n");

    // Try vector search if Voyage key available
    let candidateContext = "";
    if (voyageKey) {
      try {
        const embedResp = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${voyageKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "voyage-finance-2",
            input: `${job_title} ${job_company || ""} ${job_description || ""}`.slice(0, 4000),
          }),
        });

        if (embedResp.ok) {
          const embedData = await embedResp.json();
          const embedding = embedData.data?.[0]?.embedding;

          if (embedding) {
            const { data: chunks } = await supabase.rpc("match_resume_chunks", {
              query_embedding: embedding,
              match_threshold: 0.3,
              match_count: 100,
            });

            if (chunks?.length) {
              // Deduplicate by candidate_id, keep best match
              const seen = new Map<string, typeof chunks[0]>();
              for (const chunk of chunks) {
                if (chunk.candidate_id && !seen.has(chunk.candidate_id)) {
                  seen.set(chunk.candidate_id, chunk);
                }
              }

              const topIds = Array.from(seen.keys()).slice(0, 30);
              const { data: candidates } = await supabase
                .from("candidates")
                .select("id, full_name, current_title, current_company, location, email, status, joe_says")
                .in("id", topIds);

              if (candidates?.length) {
                candidateContext = candidates
                  .map((c) => {
                    const chunk = seen.get(c.id);
                    return `- ${c.full_name} | ${c.current_title || "?"} at ${c.current_company || "?"} | ${c.location || "?"} | Status: ${c.status}\n  Resume excerpt: ${chunk?.content?.slice(0, 300) || "N/A"}`;
                  })
                  .join("\n");

                write(`Found ${candidates.length} potential matches. Analyzing...\n\n`);
              }
            }
          }
        }
      } catch (e) {
        // Fall back to text-based matching
      }
    }

    // If no vector results, do a text-based search
    if (!candidateContext) {
      const { data: candidates } = await supabase
        .from("candidates")
        .select("id, full_name, current_title, current_company, location, status, joe_says")
        .or(`current_title.ilike.%${job_title.split(" ")[0]}%,current_company.ilike.%${(job_company || "").split(" ")[0]}%`)
        .limit(30);

      if (candidates?.length) {
        candidateContext = candidates
          .map((c) => `- ${c.full_name} | ${c.current_title || "?"} at ${c.current_company || "?"} | ${c.location || "?"} | Status: ${c.status}${c.joe_says ? `\n  Joe Says: ${(c.joe_says as string).slice(0, 200)}` : ""}`)
          .join("\n");
        write(`Found ${candidates.length} candidates. Analyzing...\n\n`);
      } else {
        write("No matching candidates found in the database.\n");
        return res.end();
      }
    }

    // Stream Claude's analysis
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
      const errText = await claudeResp.text();
      writeError(`Claude API error: ${errText}`);
      return res.end();
    }

    // Parse SSE stream from Anthropic
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
