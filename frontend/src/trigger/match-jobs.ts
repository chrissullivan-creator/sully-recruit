import { schedules, task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting, getAnthropicKey } from "./lib/supabase";

const TOP_N = 20; // candidates per job to score with Claude

async function embedText(text: string, voyageKey: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${voyageKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voyage-finance-2",
      input: [text],
      input_type: "query",
    }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

function tierFromScore(score: number): string {
  if (score >= 80) return "strong";
  if (score >= 60) return "good";
  return "worth_considering";
}

async function scoreWithClaude(
  anthropicKey: string,
  jobTitle: string,
  jobDesc: string,
  companyName: string,
  candidates: { id: string; name: string; title: string; company: string; summary: string; similarity: number }[]
): Promise<{ id: string; overall_score: number; tier: string; reasoning: string; strengths: string[]; concerns: string[] }[]> {
  const candidateBlock = candidates
    .map(
      (c, i) =>
        `[${i}] ID:${c.id} | ${c.name} | ${c.title} @ ${c.company}\nSummary: ${c.summary || "N/A"}\nVector sim: ${c.similarity.toFixed(4)}`
    )
    .join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: `You are a Wall Street recruiting expert. Score each candidate's fit for this job on a 0-100 scale.

JOB: ${jobTitle} at ${companyName}
DESCRIPTION: ${jobDesc || "No description provided"}

CANDIDATES:
${candidateBlock}

Respond ONLY with a JSON array. No markdown, no backticks, no preamble.
Each element: {"id":"<candidate uuid>","overall_score":<0-100>,"reasoning":"<1-2 sentences>","strengths":["..."],"concerns":["..."]}
Sort by overall_score descending. Only include candidates scoring 40+.`,
        },
      ],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || "[]";
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return parsed.map((p: any) => ({
      ...p,
      tier: tierFromScore(p.overall_score),
    }));
  } catch {
    logger.error("Claude parse error", { text });
    // Fallback: use vector similarity as score
    return candidates
      .filter((c) => Math.round(c.similarity * 100) >= 40)
      .map((c) => {
        const score = Math.round(c.similarity * 100);
        return {
          id: c.id,
          overall_score: score,
          tier: tierFromScore(score),
          reasoning: `${c.title} at ${c.company} — matched by resume similarity`,
          strengths: [],
          concerns: [],
        };
      });
  }
}

async function matchJob(jobId: string) {
  const supabase = getSupabaseAdmin();
  const voyageKey = await getAppSetting("VOYAGE_API_KEY");
  const anthropicKey = await getAnthropicKey();

  // Get job details
  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, description, company_name")
    .eq("id", jobId)
    .single();

  if (!job || !job.title) {
    logger.warn("Job not found or missing title", { jobId });
    return;
  }

  // Build query text from job
  const queryText = `${job.title} ${job.company_name || ""} ${job.description || ""}`.trim();
  if (queryText.length < 10) {
    logger.warn("Query text too short, skipping", { jobId });
    return;
  }

  // Embed the job
  const jobEmbedding = await embedText(queryText, voyageKey);
  if (!jobEmbedding?.length) {
    logger.error("Failed to embed job", { jobId });
    return;
  }

  // Create a run record for tracking
  const runId = crypto.randomUUID();
  await supabase.from("job_match_runs").insert({
    id: runId,
    job_id: jobId,
    status: "running",
  });

  try {
    // Vector similarity search using match_resume_chunks (the actual RPC)
    const { data: chunks, error } = await supabase.rpc("match_resume_chunks", {
      query_embedding: jobEmbedding,
      match_count: 100,
      min_similarity: 0.3,
    });

    if (error) {
      logger.error("Vector search error", { error: error.message, jobId });
      throw new Error(`Vector search failed: ${error.message}`);
    }

    // Deduplicate by candidate_id, keep highest similarity
    const candidateScores = new Map<string, number>();
    for (const chunk of chunks ?? []) {
      const existing = candidateScores.get(chunk.candidate_id) ?? 0;
      if (chunk.similarity > existing) {
        candidateScores.set(chunk.candidate_id, chunk.similarity);
      }
    }

    // Take top N candidates by similarity
    const topEntries = [...candidateScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N);

    if (!topEntries.length) {
      logger.warn("No vector matches", { jobId });
      await supabase.from("job_match_runs").update({
        status: "completed",
        candidates_scanned: 0,
        matches_found: 0,
        completed_at: new Date().toISOString(),
      }).eq("id", runId);
      return;
    }

    const candidateIds = topEntries.map(([id]) => id);
    const simMap = new Map(topEntries);

    // Get candidate details for the matched IDs
    const { data: candidates } = await supabase
      .from("candidates")
      .select("id, full_name, current_title, current_company, candidate_summary")
      .in("id", candidateIds);

    if (!candidates?.length) {
      await supabase.from("job_match_runs").update({
        status: "completed",
        candidates_scanned: 0,
        matches_found: 0,
        completed_at: new Date().toISOString(),
      }).eq("id", runId);
      return;
    }

    // Merge similarity scores
    const enriched = candidates.map((c) => ({
      id: c.id,
      name: c.full_name || "Unknown",
      title: c.current_title || "",
      company: c.current_company || "",
      summary: c.candidate_summary || "",
      similarity: simMap.get(c.id) || 0,
    }));

    // Score with Claude
    const scored = await scoreWithClaude(
      anthropicKey,
      job.title,
      job.description || "",
      job.company_name || "",
      enriched
    );

    // Build rows matching the actual table schema
    const rows = scored.map((s) => ({
      job_id: jobId,
      candidate_id: s.id,
      vector_similarity: simMap.get(s.id) || 0,
      overall_score: s.overall_score,
      tier: s.tier,
      reasoning: s.reasoning,
      strengths: s.strengths,
      concerns: s.concerns,
      run_id: runId,
    }));

    // Delete old matches for this job, insert fresh
    await supabase.from("job_candidate_matches").delete().eq("job_id", jobId);
    const { error: insertErr } = await supabase.from("job_candidate_matches").insert(rows);
    if (insertErr) {
      logger.error("Insert error", { error: insertErr, jobId });
      throw new Error(`Insert failed: ${insertErr.message}`);
    }

    await supabase.from("job_match_runs").update({
      status: "completed",
      candidates_scanned: candidates.length,
      matches_found: rows.length,
      completed_at: new Date().toISOString(),
    }).eq("id", runId);

    logger.info("Matched job", { jobId, title: job.title, candidatesScored: scored.length });
  } catch (err: any) {
    await supabase.from("job_match_runs").update({
      status: "failed",
      error_message: err.message,
      completed_at: new Date().toISOString(),
    }).eq("id", runId);
    throw err;
  }
}

// ── Scheduled task: processes ONE job per run, oldest-matched first ──
// Schedule this every 3-5 minutes in the Trigger.dev dashboard — over ~1-2 hours
// all active jobs get refreshed. Keeps each run well under the 5-min timeout.
export const matchAllJobs = schedules.task({
  id: "match-all-jobs",
  maxDuration: 180,
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Find the active job whose matches are oldest (or never matched)
    const { data: jobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("id, title, job_candidate_matches(created_at)")
      .in("status", ["lead", "hot"]);

    if (jobsErr) {
      logger.error("Failed to list jobs", { error: jobsErr.message });
      throw jobsErr;
    }
    if (!jobs?.length) {
      logger.info("No active jobs to match");
      return { matched: 0, skipped: true };
    }

    // Sort: never-matched first, then oldest created_at
    const sorted = jobs
      .map((j: any) => {
        const times: string[] = (j.job_candidate_matches ?? []).map((m: any) => m.created_at);
        const latest = times.length ? Math.max(...times.map((t) => new Date(t).getTime())) : 0;
        return { id: j.id, title: j.title, latest };
      })
      .sort((a, b) => a.latest - b.latest);

    const next = sorted[0];
    logger.info("Matching next job", {
      jobId: next.id,
      title: next.title,
      lastMatchedAt: next.latest ? new Date(next.latest).toISOString() : "never",
      queueSize: sorted.length,
    });

    try {
      await matchJob(next.id);
      return { matched: 1, jobId: next.id, title: next.title, queueSize: sorted.length };
    } catch (err: any) {
      logger.error("Error matching job", { jobId: next.id, error: err.message, stack: err.stack });
      throw err;
    }
  },
});

// ── Manual trigger: match a single job on demand ──
export const matchSingleJob = task({
  id: "match-single-job",
  maxDuration: 120,
  run: async (payload: { jobId: string }) => {
    await matchJob(payload.jobId);
    return { success: true, jobId: payload.jobId };
  },
});
