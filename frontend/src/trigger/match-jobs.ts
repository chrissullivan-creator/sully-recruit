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

// ── Scheduled task: runs every 8 hours (set schedule in Trigger.dev dashboard) ──
export const matchAllJobs = schedules.task({
  id: "match-all-jobs",
  maxDuration: 300,
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Match active jobs (lead + hot), skip closed_won/closed_lost
    const { data: jobs } = await supabase
      .from("jobs")
      .select("id")
      .in("status", ["lead", "hot"]);

    if (!jobs?.length) {
      logger.info("No open jobs to match");
      return { matched: 0 };
    }

    let matched = 0;
    const errors: string[] = [];
    for (const job of jobs) {
      try {
        await matchJob(job.id);
        matched++;
      } catch (err: any) {
        const msg = `${job.id}: ${err.message}`;
        errors.push(msg);
        logger.error("Error matching job", { jobId: job.id, error: err.message, stack: err.stack });
      }
    }

    return { matched, total: jobs.length, errors };
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
