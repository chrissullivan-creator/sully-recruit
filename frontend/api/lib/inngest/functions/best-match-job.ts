import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getOpenRouterKey,
  getVoyageKey,
} from "../../../../src/server-lib/supabase.js";
import { callAIWithFallback } from "../../../../src/lib/ai-fallback.js";
import { searchResumeEmbeddings } from "../../voyage.js";

/**
 * AI candidate→job matching engine.
 *
 * Flow (event `job/best-match.requested`):
 *   1. Load the job → build a search/embedding text from its title, company,
 *      location, comp and description.
 *   2. Vector-search resume_embeddings (Voyage voyage-finance-2 + pgvector via
 *      the match_resume_embeddings RPC) for ~40 candidate matches. Falls back
 *      to a keyword search inside searchResumeEmbeddings when vectors miss.
 *   3. Enrich each candidate from the `people` base table (roles @> ['candidate'],
 *      not soft-deleted) and pull their CALL INTEL: ai_call_notes (Joe's call
 *      summary, extracted notes/comp/reason-for-leaving) plus whether they have
 *      any call_logs at all (= they've actually been spoken to / vetted).
 *   4. Build a scoring context from BOTH the résumé signal AND the call notes.
 *      Candidates with call history get a "VETTED — has call history" flag and a
 *      score boost so vetted people rise to the top, but strong résumé-only
 *      matches still make the cut.
 *   5. callAIWithFallback (all four provider keys) → STRICT JSON scoring of the
 *      top 20 → upsert into job_candidate_matches keyed on (job_id, candidate_id),
 *      stamped with this run_id + vector_similarity.
 *   6. Mark the job_match_runs row 'completed' (with counts) or 'failed'.
 *
 * Cap: 20 matches. Retrieval cap: 40 candidates.
 */

const RETRIEVE_LIMIT = 40;
const SCORE_LIMIT = 20;

/** Bonus added to a candidate's AI score when they've been spoken to. */
const CALL_BOOST = 8;

const SYSTEM_PROMPT = `You are Joe, the AI backbone of Sully Recruit — a Wall Street recruiting CRM for The Emerald Recruiting Group, which places talent at hedge funds, investment banks, prop trading shops, asset managers, and fintech firms.

You are scoring how well each candidate fits a specific open role. You are given, per candidate, BOTH a résumé signal (an excerpt of their parsed résumé/profile, surfaced by vector search) AND call intel (Joe's summary + extracted notes from real phone calls with the candidate, when we've spoken to them).

How to weigh the signals:
- Treat candidates we have ACTUALLY SPOKEN TO (marked "VETTED — has call history") as higher-confidence: the call intel reveals genuine interest, compensation, reason for leaving, and fit that a résumé can't. Favor vetted candidates when fit is otherwise comparable.
- Still score strong résumé-only matches on their merits — a great résumé fit with no call yet can absolutely outrank a weak vetted one.
- Use the call intel (comp expectations, what they want next, dislikes about current role, relocation, visa) to judge realistic fit, not just keyword overlap.

Scoring scale (overall_score, integer 0-100):
- 80-100: strong fit — would confidently submit.
- 60-79: good fit — worth a conversation.
- 40-59: worth considering — partial fit / gaps.
- below 40: weak fit — skip.

Map overall_score to tier EXACTLY:
- score >= 80 -> "strong"
- score 60-79 -> "good"
- score 40-59 -> "worth_considering"
- score < 40 -> "worth_considering" (but you should generally drop these)

Return ONLY a JSON array (no prose, no markdown fences) of at most 20 objects, best fit first, of the shape:
[{"candidate_id":"<uuid>","overall_score":<int 0-100>,"tier":"strong|good|worth_considering","reasoning":"1-2 sharp sentences on why this fit, citing résumé AND call signal where available","strengths":["short phrase", ...],"concerns":["short phrase", ...]}]

Rules:
- Use ONLY candidate_id values from the provided list. Never invent candidates.
- 2-4 strengths and 0-3 concerns per candidate, each a short phrase (not a sentence).
- Be opinionated and specific. Drop candidates that clearly don't fit rather than padding the list.`;

interface CandidateRow {
  id: string;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  location_text: string | null;
  status: string | null;
  joe_says: string | null;
  skills: string[] | null;
  target_roles: string | null;
  target_locations: string | null;
  relocation_preference: string | null;
  reason_for_leaving: string | null;
  current_base_comp: number | null;
  current_bonus_comp: number | null;
  current_total_comp: number | null;
  target_base_comp: number | null;
  target_total_comp: number | null;
}

interface CallIntel {
  summaries: string[];
  notes: string[];
  reasonForLeaving: string | null;
  currentBase: number | null;
  currentBonus: number | null;
  targetBase: number | null;
  targetBonus: number | null;
  callCount: number;
}

function fmtComp(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString("en-US")}`;
}

/**
 * Core runner shared by the on-demand event handler and the hot-jobs cron.
 * `runId` may be pre-created (on-demand) or null (cron → we create it).
 */
async function runBestMatch(
  supabase: any,
  logger: any,
  jobId: string,
  existingRunId: string | null,
): Promise<{ runId: string; matches_found: number; candidates_scanned: number; status: string }> {
  // Resolve (or create) the run row first so any failure can be recorded.
  let runId = existingRunId;
  if (!runId) {
    const { data: run, error: runErr } = await supabase
      .from("job_match_runs")
      .insert({ job_id: jobId, status: "running" })
      .select("id")
      .single();
    if (runErr || !run) {
      throw new Error(`Failed to create run row: ${runErr?.message ?? "unknown"}`);
    }
    runId = run.id as string;
  }

  const fail = async (message: string) => {
    await supabase
      .from("job_match_runs")
      .update({ status: "failed", error_message: message.slice(0, 1000), completed_at: new Date().toISOString() })
      .eq("id", runId);
    return { runId: runId as string, matches_found: 0, candidates_scanned: 0, status: "failed" };
  };

  try {
    // 1) Load the job.
    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .select("id, title, company_name, location, description, compensation, additional_notes")
      .eq("id", jobId)
      .is("deleted_at", null)
      .maybeSingle();

    if (jobErr) return await fail(`Failed to load job: ${jobErr.message}`);
    if (!job) return await fail("Job not found");

    // 2) Embed + retrieve candidate matches. searchResumeEmbeddings reads
    //    VOYAGE_API_KEY from env; mirror the app_settings pattern so it works
    //    even if only the app_settings copy is populated.
    if (!process.env.VOYAGE_API_KEY) {
      const vk = await getVoyageKey().catch(() => "");
      if (vk) process.env.VOYAGE_API_KEY = vk;
    }

    const searchText = [
      `Title: ${job.title ?? ""}`,
      job.company_name ? `Company: ${job.company_name}` : "",
      job.location ? `Location: ${job.location}` : "",
      job.compensation ? `Compensation: ${job.compensation}` : "",
      job.description ? `Description: ${String(job.description).slice(0, 3000)}` : "",
      job.additional_notes ? `Notes: ${String(job.additional_notes).slice(0, 800)}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 6000);

    const matches = await searchResumeEmbeddings(supabase, searchText, RETRIEVE_LIMIT);
    if (matches.length === 0) {
      // No candidates at all — complete cleanly with zero matches.
      await supabase
        .from("job_match_runs")
        .update({ status: "completed", candidates_scanned: 0, matches_found: 0, completed_at: new Date().toISOString() })
        .eq("id", runId);
      logger.info("best-match: no candidates retrieved", { jobId, runId });
      return { runId: runId as string, matches_found: 0, candidates_scanned: 0, status: "completed" };
    }

    const simById = new Map<string, number>();
    for (const m of matches) simById.set(m.candidate_id, m.similarity ?? 0);
    const resumeById = new Map<string, string>();
    for (const m of matches) resumeById.set(m.candidate_id, m.content || "");
    const ids = [...simById.keys()];

    // 3a) Enrich from the people base table. The `candidates` view is an
    //     unfiltered SELECT over people, so hitting `people` directly lets us
    //     filter roles + exclude soft-deleted rows.
    const { data: peopleRows, error: peopleErr } = await supabase
      .from("people")
      .select(
        "id, full_name, current_title, current_company, location_text, status, joe_says, skills, " +
          "target_roles, target_locations, relocation_preference, reason_for_leaving, " +
          "current_base_comp, current_bonus_comp, current_total_comp, target_base_comp, target_total_comp",
      )
      .in("id", ids)
      .contains("roles", ["candidate"])
      .is("deleted_at", null);

    if (peopleErr) return await fail(`Failed to enrich candidates: ${peopleErr.message}`);

    const people = (peopleRows || []) as CandidateRow[];
    if (people.length === 0) {
      await supabase
        .from("job_match_runs")
        .update({ status: "completed", candidates_scanned: 0, matches_found: 0, completed_at: new Date().toISOString() })
        .eq("id", runId);
      logger.info("best-match: retrieved rows but none are candidates", { jobId, runId });
      return { runId: runId as string, matches_found: 0, candidates_scanned: 0, status: "completed" };
    }

    const candidateIds = people.map((p) => p.id);

    // 3b) Call intel: ai_call_notes (Joe's summary + extracted fields) and a
    //     presence check on call_logs (= we've actually spoken to them).
    const [{ data: callNotes }, { data: callLogRows }] = await Promise.all([
      supabase
        .from("ai_call_notes")
        .select(
          "candidate_id, ai_summary, extracted_notes, extracted_reason_for_leaving, " +
            "extracted_current_base, extracted_current_bonus, extracted_target_base, extracted_target_bonus, " +
            "call_duration_seconds, call_started_at",
        )
        .in("candidate_id", candidateIds)
        .order("call_started_at", { ascending: false }),
      supabase
        .from("call_logs")
        .select("candidate_id")
        .in("candidate_id", candidateIds),
    ]);

    const intelById = new Map<string, CallIntel>();
    for (const n of (callNotes || []) as any[]) {
      const cid = n.candidate_id as string;
      if (!cid) continue;
      let intel = intelById.get(cid);
      if (!intel) {
        intel = {
          summaries: [],
          notes: [],
          reasonForLeaving: null,
          currentBase: null,
          currentBonus: null,
          targetBase: null,
          targetBonus: null,
          callCount: 0,
        };
        intelById.set(cid, intel);
      }
      intel.callCount += 1;
      if (n.ai_summary) intel.summaries.push(String(n.ai_summary));
      if (n.extracted_notes) intel.notes.push(String(n.extracted_notes));
      if (!intel.reasonForLeaving && n.extracted_reason_for_leaving) intel.reasonForLeaving = String(n.extracted_reason_for_leaving);
      if (intel.currentBase == null && n.extracted_current_base != null) intel.currentBase = n.extracted_current_base;
      if (intel.currentBonus == null && n.extracted_current_bonus != null) intel.currentBonus = n.extracted_current_bonus;
      if (intel.targetBase == null && n.extracted_target_base != null) intel.targetBase = n.extracted_target_base;
      if (intel.targetBonus == null && n.extracted_target_bonus != null) intel.targetBonus = n.extracted_target_bonus;
    }

    // call_logs presence → "has been spoken to". A row in either ai_call_notes
    // or call_logs counts as call history.
    const hasCallLog = new Set<string>();
    for (const r of (callLogRows || []) as any[]) {
      if (r.candidate_id) hasCallLog.add(r.candidate_id as string);
    }
    const hasCallHistory = (cid: string) => hasCallLog.has(cid) || (intelById.get(cid)?.callCount ?? 0) > 0;

    // 4) Build the LLM scoring context from BOTH résumé + call signals.
    //    Order vetted candidates first so the model sees them up top.
    const ordered = [...people].sort((a, b) => {
      const av = hasCallHistory(a.id) ? 1 : 0;
      const bv = hasCallHistory(b.id) ? 1 : 0;
      if (av !== bv) return bv - av;
      return (simById.get(b.id) ?? 0) - (simById.get(a.id) ?? 0);
    });

    const jobContext = [
      `Title: ${job.title ?? "(not specified)"}`,
      job.company_name ? `Company: ${job.company_name}` : "Company: (confidential)",
      job.location ? `Location: ${job.location}` : "",
      job.compensation ? `Compensation: ${job.compensation}` : "",
      job.description ? `Description:\n${String(job.description).slice(0, 3000)}` : "",
      job.additional_notes ? `Additional notes:\n${String(job.additional_notes).slice(0, 800)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const candidateContext = ordered
      .map((c) => {
        const sim = simById.get(c.id) ?? 0;
        const resume = (resumeById.get(c.id) || "").slice(0, 600);
        const intel = intelById.get(c.id);
        const vetted = hasCallHistory(c.id);

        const lines: string[] = [];
        lines.push(`### candidate_id: ${c.id}`);
        lines.push(
          `${c.full_name || "Unknown"} | ${c.current_title || "?"} at ${c.current_company || "?"} | ${c.location_text || "?"} | pipeline status: ${c.status || "?"} | résumé match: ${sim.toFixed(2)}`,
        );
        lines.push(vetted ? "VETTED — has call history (we've spoken to this person)" : "NOT yet called (résumé-only signal)");
        if (c.skills?.length) lines.push(`Skills: ${c.skills.slice(0, 20).join(", ")}`);
        if (c.target_roles) lines.push(`Target roles: ${c.target_roles}`);
        if (c.target_locations) lines.push(`Target locations: ${c.target_locations}`);
        if (c.relocation_preference) lines.push(`Relocation: ${c.relocation_preference}`);

        const curBase = intel?.currentBase ?? c.current_base_comp;
        const curBonus = intel?.currentBonus ?? c.current_bonus_comp;
        const tgtBase = intel?.targetBase ?? c.target_base_comp;
        if (curBase != null || curBonus != null || c.current_total_comp != null) {
          lines.push(`Current comp: base ${fmtComp(curBase)} / bonus ${fmtComp(curBonus)} / total ${fmtComp(c.current_total_comp)}`);
        }
        if (tgtBase != null || c.target_total_comp != null) {
          lines.push(`Target comp: base ${fmtComp(tgtBase)} / total ${fmtComp(c.target_total_comp)}`);
        }
        const rfl = intel?.reasonForLeaving || c.reason_for_leaving;
        if (rfl) lines.push(`Reason for leaving: ${String(rfl).slice(0, 300)}`);

        if (c.joe_says) lines.push(`Joe's brief: ${String(c.joe_says).slice(0, 500)}`);
        if (intel?.summaries.length) lines.push(`Call summary: ${intel.summaries.slice(0, 2).join(" | ").slice(0, 700)}`);
        if (intel?.notes.length) lines.push(`Call notes: ${intel.notes.slice(0, 2).join(" | ").slice(0, 500)}`);
        if (resume) lines.push(`Résumé excerpt: ${resume}`);

        return lines.join("\n");
      })
      .join("\n\n");

    // 5) Score with the AI cascade (all four keys).
    const [anthropicKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
      getAnthropicKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
      getGeminiKey().catch(() => ""),
      getOpenRouterKey().catch(() => ""),
    ]);

    if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
      return await fail("No AI provider key configured");
    }

    const userContent = `Score these ${ordered.length} candidates for the role below. Return the JSON array described in the system prompt (at most ${SCORE_LIMIT}, best fit first).

## Job
${jobContext}

## Candidates
${candidateContext}`;

    const { text, via } = await callAIWithFallback({
      anthropicKey: anthropicKey || undefined,
      openaiKey: openaiKey || undefined,
      geminiKey: geminiKey || undefined,
      openRouterKey: openRouterKey || undefined,
      systemPrompt: SYSTEM_PROMPT,
      userContent,
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      temperature: 0.2,
      jsonOutput: true,
    });

    const scored = parseScores(text);
    if (scored.length === 0) {
      return await fail(`AI returned no parseable scores (via ${via})`);
    }

    // 6) Apply the vetted boost, clamp, validate ids, sort, cap, upsert.
    const validIds = new Set(candidateIds);
    const now = new Date().toISOString();

    const rows = scored
      .filter((s) => s.candidate_id && validIds.has(s.candidate_id))
      .map((s) => {
        const base = clampScore(s.overall_score);
        const boosted = hasCallHistory(s.candidate_id) ? Math.min(100, base + CALL_BOOST) : base;
        return {
          job_id: jobId,
          candidate_id: s.candidate_id,
          score: boosted,
          overall_score: boosted,
          tier: tierFor(boosted),
          reasoning: (s.reasoning || "").slice(0, 2000),
          strengths: Array.isArray(s.strengths) ? s.strengths.slice(0, 6).map(String) : [],
          concerns: Array.isArray(s.concerns) ? s.concerns.slice(0, 6).map(String) : [],
          vector_similarity: simById.get(s.candidate_id) ?? null,
          run_id: runId,
          matched_at: now,
          updated_at: now,
        };
      })
      .sort((a, b) => b.overall_score - a.overall_score)
      .slice(0, SCORE_LIMIT);

    if (rows.length === 0) {
      return await fail("AI scores did not match any retrieved candidate");
    }

    const { error: upsertErr } = await supabase
      .from("job_candidate_matches")
      .upsert(rows, { onConflict: "job_id,candidate_id" });

    if (upsertErr) return await fail(`Failed to upsert matches: ${upsertErr.message}`);

    await supabase
      .from("job_match_runs")
      .update({
        status: "completed",
        candidates_scanned: people.length,
        matches_found: rows.length,
        completed_at: now,
      })
      .eq("id", runId);

    logger.info("best-match: completed", {
      jobId,
      runId,
      via,
      scanned: people.length,
      matched: rows.length,
      vetted: rows.filter((r) => hasCallHistory(r.candidate_id)).length,
    });

    return { runId: runId as string, matches_found: rows.length, candidates_scanned: people.length, status: "completed" };
  } catch (err: any) {
    logger.error("best-match: failed", { jobId, runId, error: err?.message });
    return await fail(err?.message || "unknown error");
  }
}

function clampScore(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function tierFor(score: number): "strong" | "good" | "worth_considering" {
  if (score >= 80) return "strong";
  if (score >= 60) return "good";
  return "worth_considering";
}

interface ScoredCandidate {
  candidate_id: string;
  overall_score: number;
  tier?: string;
  reasoning?: string;
  strengths?: unknown[];
  concerns?: unknown[];
}

/** Tolerant JSON-array extraction (handles ```json fences / prose wrap). */
// Pull the score array out of whatever shape the model returned: a bare array,
// or an object wrapping it under any key. JSON-mode providers (OpenAI's
// response_format=json_object) MUST return an object, so the array arrives as
// e.g. {"candidates":[...]} or {"scores":[...]} — take the first array-valued
// property.
function firstScoreArray(value: unknown): ScoredCandidate[] | null {
  if (Array.isArray(value)) return value as ScoredCandidate[];
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as ScoredCandidate[];
    }
  }
  return null;
}

function parseScores(text: string): ScoredCandidate[] {
  if (!text) return [];
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();

  // Parse the whole payload first. This handles a bare array AND the
  // object-wrapped shape JSON-mode providers must return. The old code sliced
  // first-'[' to last-']', which corrupted object payloads whose items contain
  // nested arrays (strengths/concerns) → JSON.parse threw → zero scores → the
  // run failed with "AI returned no parseable scores".
  try {
    const direct = firstScoreArray(JSON.parse(raw));
    if (direct) return direct;
  } catch {
    /* fall through to substring extraction for prose-wrapped payloads */
  }

  // Fallback: extract the outermost object, then the outermost array substring.
  const attempts: string[] = [];
  const objStart = raw.indexOf("{");
  const objEnd = raw.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) attempts.push(raw.slice(objStart, objEnd + 1));
  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) attempts.push(raw.slice(arrStart, arrEnd + 1));
  for (const candidate of attempts) {
    try {
      const arr = firstScoreArray(JSON.parse(candidate));
      if (arr) return arr;
    } catch {
      /* try next */
    }
  }
  return [];
}

// ─── On-demand event handler ────────────────────────────────────────────────
export const bestMatchJob = inngest.createFunction(
  {
    id: "best-match-job",
    name: "AI best-match candidates to a job",
    retries: 1,
    concurrency: [{ key: "event.data.jobId", limit: 1 }],
  },
  { event: "job/best-match.requested" },
  async ({ event, logger }) => {
    const jobId = String((event.data as any)?.jobId ?? "");
    const runId = (event.data as any)?.runId ? String((event.data as any).runId) : null;
    if (!jobId) return { skipped: true, reason: "missing jobId" };
    const supabase = getSupabaseAdmin();
    return runBestMatch(supabase, logger, jobId, runId);
  },
);

// ─── Hot-jobs cron ──────────────────────────────────────────────────────────
// Keeps every `status='hot'` req fresh by fanning out a best-match event per
// hot job. Reuses the same event/handler as the on-demand path (each fanned
// event has no runId, so the handler creates its own run row).
export const bestMatchHotJobsCron = inngest.createFunction(
  {
    id: "best-match-hot-jobs-cron",
    name: "Best-match all hot jobs (Inngest cron)",
  },
  // Every 6 hours.
  { cron: "0 */6 * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const { data: jobs, error } = await supabase
      .from("jobs")
      .select("id")
      .eq("status", "hot")
      .is("deleted_at", null);

    if (error) {
      logger.error("best-match hot cron: job query failed", { error: error.message });
      return { dispatched: 0, error: error.message };
    }
    if (!jobs?.length) {
      logger.info("best-match hot cron: no hot jobs");
      return { dispatched: 0 };
    }

    const events = (jobs as any[]).map((j) => ({
      name: "job/best-match.requested" as const,
      data: { jobId: j.id as string },
    }));

    // Inngest accepts up to ~100 events per send; chunk to stay safe.
    for (let i = 0; i < events.length; i += 100) {
      await inngest.send(events.slice(i, i + 100));
    }

    logger.info("best-match hot cron: dispatched", { dispatched: events.length });
    return { dispatched: events.length };
  },
);
