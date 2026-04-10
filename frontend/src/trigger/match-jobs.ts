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

async function scoreWithClaude(
  anthropicKey: string,
  jobTitle: string,
  jobDesc: string,
  companyName: string,
  candidates: { id: string; name: string; title: string; company: string; summary: string; similarity: number }[]
): Promise<{ id: string; score: number; blurb: string }[]> {
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
          content: `You are a Wall Street recruiting expert. Score each candidate's fit for this job on a 0-100 scale and write a 1-sentence blurb explaining the match.

JOB: ${jobTitle} at ${companyName}
DESCRIPTION: ${jobDesc || "No description provided"}

CANDIDATES:
${candidateBlock}

Respond ONLY with a JSON array. No markdown, no backticks, no preamble.
Each element: {"id":"<candidate uuid>","score":<0-100>,"blurb":"<1 sentence>"}
Sort by score descending.`,
        },
      ],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || "[]";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    logger.error("Claude parse error", { text });
    // Fallback: use vector similarity as score
    return candidates.map((c) => ({
      id: c.id,
      score: Math.round(c.similarity * 100),
      blurb: `${c.title} at ${c.company} — vector match`,
    }));
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

  // Vector similarity search against resume_embeddings
  const { data: matches, error } = await supabase.rpc("match_candidates_for_job", {
    query_embedding: jobEmbedding,
    match_count: TOP_N,
  });

  if (error) {
    logger.error("Vector search error", { error: error.message, jobId });
    throw new Error(`Vector search failed: ${error.message}`);
  }
  if (!matches?.length) {
    logger.warn("No vector matches", { jobId });
    return;
  }

  // Get candidate details for the matched IDs
  const candidateIds = matches.map((m: any) => m.candidate_id);
  const { data: candidates } = await supabase
    .from("candidates")
    .select("id, full_name, current_title, current_company, candidate_summary")
    .in("id", candidateIds);

  if (!candidates?.length) return;

  // Merge similarity scores
  const simMap = new Map(matches.map((m: any) => [m.candidate_id, m.similarity]));
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

  // Upsert matches
  const rows = scored.map((s) => ({
    job_id: jobId,
    candidate_id: s.id,
    score: s.score,
    blurb: s.blurb,
    vector_similarity: simMap.get(s.id) || 0,
    matched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  // Delete old matches for this job, insert fresh
  await supabase.from("job_candidate_matches").delete().eq("job_id", jobId);
  const { error: insertErr } = await supabase.from("job_candidate_matches").insert(rows);
  if (insertErr) logger.error("Insert error", { error: insertErr, jobId });

  logger.info("Matched job", { jobId, title: job.title, candidatesScored: scored.length });
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
      .select("id, title, job_candidate_matches(matched_at)")
      .in("status", ["lead", "hot"]);

    if (jobsErr) {
      logger.error("Failed to list jobs", { error: jobsErr.message });
      throw jobsErr;
    }
    if (!jobs?.length) {
      logger.info("No active jobs to match");
      return { matched: 0, skipped: true };
    }

    // Sort: never-matched first, then oldest matched_at
    const sorted = jobs
      .map((j: any) => {
        const times: string[] = (j.job_candidate_matches ?? []).map((m: any) => m.matched_at);
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
