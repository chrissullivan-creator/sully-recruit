import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey, getVoyageKey } from "./lib/supabase";

interface BestMatchJobPayload {
  jobId: string;
  runId: string;
}

const MATCH_SYSTEM_PROMPT = `You are Joe — the AI backbone of Sully Recruit, a Wall Street-focused recruiting CRM for The Emerald Recruiting Group. You place talent at hedge funds, investment banks, prop trading firms, asset managers, and financial services firms.

You are evaluating candidates for a specific job. For each candidate, assess their fit based on:
- Title/role alignment (how closely their experience matches the job)
- Industry fit (finance, banking, trading, asset management)
- Skills match (technical and domain skills)
- Location compatibility (considering relocation preference)
- Compensation alignment (current vs job range)
- Work authorization (if relevant)
- Career trajectory (growth pattern, tenure, prestige)
- Communication/engagement history (responsive? interested?)

Return ONLY valid JSON — no markdown, no explanation, no wrapping. Return an array of objects:

[
  {
    "candidate_id": "uuid",
    "overall_score": 85,
    "tier": "strong",
    "reasoning": "2-3 sentence explanation of why this candidate fits or doesn't",
    "strengths": ["strength 1", "strength 2"],
    "concerns": ["concern 1"]
  }
]

Scoring guide:
- 80-100 = "strong" — excellent fit, should be submitted
- 60-79 = "good" — solid fit with minor gaps
- 40-59 = "worth_considering" — possible fit, notable concerns
- Below 40 = do not include in results

Be sharp, specific, and honest. Reference actual details from the candidate profile.`;

export const bestMatchJob = task({
  id: "best-match-job",
  retry: { maxAttempts: 2 },
  run: async (payload: BestMatchJobPayload) => {
    const { jobId, runId } = payload;
    const supabase = getSupabaseAdmin();
    const [anthropicKey, voyageKey] = await Promise.all([
      getAnthropicKey(),
      getVoyageKey(),
    ]);

    logger.info("Starting best-match-job", { jobId, runId });

    try {
      // ── Stage 1: Fetch job details ──────────────────────────────────────
      const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .select("*, companies(name, industry, location)")
        .eq("id", jobId)
        .single();

      if (jobErr || !job) {
        throw new Error(`Job not found: ${jobErr?.message ?? jobId}`);
      }

      const jobText = buildJobText(job);
      logger.info("Job context built", { jobId, textLength: jobText.length });

      // ── Stage 2: Embed job description with Voyage AI ───────────────────
      const jobEmbedding = await embedQuery(jobText, voyageKey);

      if (!jobEmbedding) {
        throw new Error("Failed to embed job description with Voyage AI");
      }

      logger.info("Job embedding created", { dimensions: jobEmbedding.length });

      // ── Stage 3: Vector search for similar resume chunks ────────────────
      const { data: chunks, error: chunkErr } = await supabase.rpc(
        "match_resume_chunks",
        {
          query_embedding: jobEmbedding,
          match_count: 150,
          min_similarity: 0.3,
        },
      );

      if (chunkErr) {
        logger.error("Vector search failed", { error: chunkErr.message });
        throw new Error(`Vector search failed: ${chunkErr.message}`);
      }

      // Deduplicate by candidate_id, keep highest similarity
      const candidateScores = new Map<string, number>();
      for (const chunk of chunks ?? []) {
        const existing = candidateScores.get(chunk.candidate_id) ?? 0;
        if (chunk.similarity > existing) {
          candidateScores.set(chunk.candidate_id, chunk.similarity);
        }
      }

      // Sort by similarity and take top 30
      const topCandidateIds = [...candidateScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([id]) => id);

      logger.info("Vector search complete", {
        totalChunks: chunks?.length ?? 0,
        uniqueCandidates: candidateScores.size,
        topN: topCandidateIds.length,
      });

      if (topCandidateIds.length === 0) {
        await supabase
          .from("job_match_runs")
          .update({
            status: "completed",
            candidates_scanned: 0,
            matches_found: 0,
            completed_at: new Date().toISOString(),
          })
          .eq("id", runId);

        return { success: true, matches: 0 };
      }

      // Update run progress
      await supabase
        .from("job_match_runs")
        .update({ candidates_scanned: topCandidateIds.length })
        .eq("id", runId);

      // ── Stage 4: Gather candidate profiles in bulk ──────────────────────
      const candidateProfiles = await gatherBulkCandidateProfiles(
        supabase,
        topCandidateIds,
        candidateScores,
      );

      logger.info("Candidate profiles gathered", { count: candidateProfiles.length });

      // ── Stage 5: Claude rerank in batches of 10 ─────────────────────────
      const allMatches: any[] = [];
      const batchSize = 10;

      for (let i = 0; i < candidateProfiles.length; i += batchSize) {
        const batch = candidateProfiles.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(candidateProfiles.length / batchSize);

        logger.info(`Scoring batch ${batchNum}/${totalBatches}`, {
          candidates: batch.length,
        });

        const scored = await scoreWithClaude(
          anthropicKey,
          jobText,
          batch,
        );

        allMatches.push(...scored);
      }

      // Filter out low scores
      const qualifiedMatches = allMatches.filter((m) => m.overall_score >= 40);

      logger.info("Claude scoring complete", {
        total: allMatches.length,
        qualified: qualifiedMatches.length,
      });

      // ── Stage 6: Store results ──────────────────────────────────────────
      if (qualifiedMatches.length > 0) {
        const rows = qualifiedMatches.map((m) => ({
          job_id: jobId,
          candidate_id: m.candidate_id,
          vector_similarity: candidateScores.get(m.candidate_id) ?? null,
          overall_score: m.overall_score,
          tier: m.tier,
          reasoning: m.reasoning,
          strengths: m.strengths ?? [],
          concerns: m.concerns ?? [],
          run_id: runId,
        }));

        const { error: insertErr } = await supabase
          .from("job_candidate_matches")
          .insert(rows);

        if (insertErr) {
          logger.error("Failed to insert matches", { error: insertErr.message });
          throw new Error(`Insert failed: ${insertErr.message}`);
        }
      }

      // Update run as completed
      await supabase
        .from("job_match_runs")
        .update({
          status: "completed",
          matches_found: qualifiedMatches.length,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId);

      logger.info("Best match job complete", {
        jobId,
        runId,
        matches: qualifiedMatches.length,
      });

      return { success: true, matches: qualifiedMatches.length };
    } catch (err: any) {
      logger.error("Best match job failed", { error: err.message });

      await supabase
        .from("job_match_runs")
        .update({
          status: "failed",
          error_message: err.message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId);

      throw err;
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// BUILD JOB TEXT
// ─────────────────────────────────────────────────────────────────────────────
function buildJobText(job: any): string {
  const company = job.companies;
  const parts = [
    `Job Title: ${job.title}`,
    `Company: ${company?.name ?? job.company ?? "—"}`,
    `Industry: ${company?.industry ?? "Financial Services"}`,
    `Location: ${job.location ?? company?.location ?? "—"}`,
    `Salary: ${job.salary ?? "—"}`,
    `Compensation: ${job.compensation ?? "—"}`,
    `Priority: ${job.priority ?? "—"}`,
    `Hiring Manager: ${job.hiring_manager ?? "—"}`,
  ];

  if (job.description) parts.push(`Description:\n${job.description}`);
  if (job.notes) parts.push(`Notes:\n${job.notes}`);

  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBED QUERY WITH VOYAGE AI (input_type: "query" for search)
// ─────────────────────────────────────────────────────────────────────────────
async function embedQuery(text: string, apiKey: string): Promise<number[] | null> {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "voyage-finance-2",
      input: text,
      input_type: "query",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    logger.error("Voyage API error", { error: errText });
    return null;
  }

  const data = await resp.json();
  return data.data?.[0]?.embedding ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GATHER BULK CANDIDATE PROFILES
// ─────────────────────────────────────────────────────────────────────────────
async function gatherBulkCandidateProfiles(
  supabase: any,
  candidateIds: string[],
  vectorScores: Map<string, number>,
): Promise<any[]> {
  // Fetch all data in parallel
  const [candidates, workHistory, education, resumes] = await Promise.all([
    supabase
      .from("candidates")
      .select(
        "id, first_name, last_name, full_name, current_title, current_company, " +
          "location_text, skills, work_authorization, relocation_preference, " +
          "target_locations, target_roles, reason_for_leaving, " +
          "current_base_comp, current_bonus_comp, current_total_comp, " +
          "target_base_comp, target_total_comp, comp_notes, " +
          "joe_says, candidate_summary, back_of_resume_notes, " +
          "status, last_sequence_sentiment, notice_period",
      )
      .in("id", candidateIds)
      .then((r: any) => r.data ?? []),

    supabase
      .from("candidate_work_history")
      .select("candidate_id, title, company_name, start_date, end_date, is_current")
      .in("candidate_id", candidateIds)
      .order("start_date", { ascending: false })
      .then((r: any) => r.data ?? []),

    supabase
      .from("candidate_education")
      .select("candidate_id, institution, degree, field_of_study")
      .in("candidate_id", candidateIds)
      .then((r: any) => r.data ?? []),

    supabase
      .from("resumes")
      .select("candidate_id, ai_summary")
      .in("candidate_id", candidateIds)
      .eq("parse_status", "completed")
      .order("created_at", { ascending: false })
      .then((r: any) => r.data ?? []),
  ]);

  // Index related data by candidate_id
  const workByCandidate = groupBy(workHistory, "candidate_id");
  const eduByCandidate = groupBy(education, "candidate_id");
  const resumeByCandidate = new Map<string, string>();
  for (const r of resumes) {
    if (r.ai_summary && !resumeByCandidate.has(r.candidate_id)) {
      resumeByCandidate.set(r.candidate_id, r.ai_summary);
    }
  }

  // Build profiles
  return candidates.map((c: any) => {
    const work = workByCandidate.get(c.id) ?? [];
    const edu = eduByCandidate.get(c.id) ?? [];
    const resumeSummary = resumeByCandidate.get(c.id);
    const vectorScore = vectorScores.get(c.id);

    const workLines = work
      .slice(0, 5)
      .map(
        (w: any) =>
          `${w.title} at ${w.company_name} (${w.start_date ?? "?"} — ${w.is_current ? "Present" : w.end_date ?? "?"})`,
      );

    const eduLines = edu
      .slice(0, 3)
      .map(
        (e: any) =>
          `${e.institution}: ${e.degree ?? ""}${e.field_of_study ? ` in ${e.field_of_study}` : ""}`,
      );

    return {
      candidate_id: c.id,
      profile: [
        `Name: ${c.full_name ?? `${c.first_name ?? ""} ${c.last_name ?? ""}`}`,
        `Title: ${c.current_title ?? "—"} at ${c.current_company ?? "—"}`,
        `Location: ${c.location_text ?? "—"}`,
        `Skills: ${c.skills?.join(", ") ?? "—"}`,
        `Work Auth: ${c.work_authorization ?? "—"}`,
        `Relocation: ${c.relocation_preference ?? "—"}`,
        `Target Roles: ${c.target_roles ?? "—"}`,
        `Target Locations: ${c.target_locations ?? "—"}`,
        `Current Comp: Base ${c.current_base_comp ?? "?"}, Bonus ${c.current_bonus_comp ?? "?"}, Total ${c.current_total_comp ?? "?"}`,
        `Target Comp: Base ${c.target_base_comp ?? "?"}, Total ${c.target_total_comp ?? "?"}`,
        `Comp Notes: ${c.comp_notes ?? "—"}`,
        `Reason for Leaving: ${c.reason_for_leaving ?? "—"}`,
        `Status: ${c.status ?? "—"}`,
        `Sentiment: ${c.last_sequence_sentiment ?? "—"}`,
        `Notice Period: ${c.notice_period ?? "—"}`,
        workLines.length ? `Work History:\n  ${workLines.join("\n  ")}` : "",
        eduLines.length ? `Education:\n  ${eduLines.join("\n  ")}` : "",
        resumeSummary ? `Resume Summary: ${resumeSummary.slice(0, 1500)}` : "",
        c.joe_says ? `Joe Says: ${c.joe_says.slice(0, 1500)}` : "",
        vectorScore ? `Resume Similarity Score: ${(vectorScore * 100).toFixed(1)}%` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
}

function groupBy(arr: any[], key: string): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const item of arr) {
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE WITH CLAUDE
// ─────────────────────────────────────────────────────────────────────────────
async function scoreWithClaude(
  apiKey: string,
  jobText: string,
  candidates: { candidate_id: string; profile: string }[],
): Promise<any[]> {
  const candidateBlock = candidates
    .map(
      (c, i) => `--- CANDIDATE ${i + 1} (ID: ${c.candidate_id}) ---\n${c.profile}`,
    )
    .join("\n\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: MATCH_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `JOB:\n${jobText}\n\nCANDIDATES:\n${candidateBlock}`,
        },
      ],
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    logger.error("Claude API error during scoring", { error: errText });
    throw new Error(`Claude API error: ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || "[]";

  try {
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.error("No JSON array found in Claude response", { text: text.slice(0, 500) });
      return [];
    }
    return JSON.parse(jsonMatch[0]);
  } catch (parseErr: any) {
    logger.error("Failed to parse Claude scoring response", {
      error: parseErr.message,
      text: text.slice(0, 500),
    });
    return [];
  }
}
