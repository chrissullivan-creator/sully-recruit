/**
 * Process an enrichment_jobs row. Fired by /api/people/enrich when
 * the batch exceeds SYNC_THRESHOLD.
 *
 * Processes the job in chunks of CHUNK_SIZE people. After each chunk:
 *   1. Re-run the cascade via runEnrichmentForPeople (the same code
 *      the sync path uses — single source of truth).
 *   2. Update the job row: incremented processed/changed/failed
 *      counters + accumulated credits + appended results jsonb.
 * The frontend polls the job row every few seconds and shows live
 * progress.
 *
 * On any unhandled error the job is stamped `status='failed'` with
 * the error message — the operator sees it in the toast and a
 * separate alert email is fired via the existing alerting helper.
 */

import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";
import {
  runEnrichmentForPeople,
  type EnrichField,
  type EnrichCredits,
} from "../../enrichment-runner.js";

const CHUNK_SIZE = 10;

interface JobRow {
  id: string;
  people_ids: string[];
  fields: string[];
  total: number;
  processed: number;
  changed: number;
  failed: number;
  credits: EnrichCredits;
  linkedin_summary: { urls_found: number; profiles_synced: number; work_history_rows: number };
  results: any[];
  status: string;
}

function mergeCredits(a: Partial<EnrichCredits>, b: Partial<EnrichCredits>): EnrichCredits {
  return {
    apollo_calls: (a.apollo_calls ?? 0) + (b.apollo_calls ?? 0),
    fullenrich_calls: (a.fullenrich_calls ?? 0) + (b.fullenrich_calls ?? 0),
    bettercontact_calls: (a.bettercontact_calls ?? 0) + (b.bettercontact_calls ?? 0),
    pdl_calls: (a.pdl_calls ?? 0) + (b.pdl_calls ?? 0),
    zerobounce_checks: (a.zerobounce_checks ?? 0) + (b.zerobounce_checks ?? 0),
  };
}

export const processEnrichmentJob = inngest.createFunction(
  {
    id: "process-enrichment-job",
    name: "Process enrichment job (background)",
    // One job at a time per user — prevents one user queuing 10 huge
    // batches and starving everyone else's runs.
    concurrency: { limit: 1, key: "event.data.jobId" },
  },
  { event: "enrichment/run.requested" },
  async ({ event, step, logger }) => {
    const jobId = event.data.jobId as string;
    const supabase = getSupabaseAdmin();

    // ── load job ─────────────────────────────────────────────────
    const { data: jobRaw, error: loadErr } = await supabase
      .from("enrichment_jobs")
      .select("*")
      .eq("id", jobId)
      .single();
    if (loadErr || !jobRaw) {
      logger.error("enrichment job not found", { jobId, err: loadErr?.message });
      return { ok: false, error: "job not found" };
    }
    const job = jobRaw as JobRow;

    if (job.status === "completed" || job.status === "failed") {
      logger.warn("job already finished, skipping", { jobId, status: job.status });
      return { ok: true, skipped: true };
    }

    // Stamp running. Use step.run so Inngest's retry semantics don't
    // re-stamp on a transient failure.
    await step.run("mark-running", async () => {
      await supabase
        .from("enrichment_jobs")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", jobId);
    });

    // ── chunk + process ──────────────────────────────────────────
    let credits: EnrichCredits = job.credits ?? {
      apollo_calls: 0, fullenrich_calls: 0, bettercontact_calls: 0,
      pdl_calls: 0, zerobounce_checks: 0,
    };
    let linkedinSummary = job.linkedin_summary ?? {
      urls_found: 0, profiles_synced: 0, work_history_rows: 0,
    };
    const accumulatedResults: any[] = Array.isArray(job.results) ? [...job.results] : [];
    let processedTotal = job.processed ?? 0;
    let changedTotal = job.changed ?? 0;
    let failedTotal = job.failed ?? 0;

    // Resume from where the previous run left off if Inngest retried.
    const remainingIds = job.people_ids.slice(processedTotal);

    try {
      for (let i = 0; i < remainingIds.length; i += CHUNK_SIZE) {
        const chunk = remainingIds.slice(i, i + CHUNK_SIZE);
        const chunkLabel = `chunk-${processedTotal}-${processedTotal + chunk.length}`;

        const { results: chunkResults, credits: chunkCredits } = await step.run(chunkLabel, async () => {
          return await runEnrichmentForPeople(supabase, chunk, job.fields as EnrichField[]);
        });

        // Aggregate.
        credits = mergeCredits(credits, chunkCredits);
        for (const r of chunkResults) {
          accumulatedResults.push(r);
          if (r.linkedin?.found_url) linkedinSummary.urls_found += 1;
          if (r.linkedin?.profile_fetched) linkedinSummary.profiles_synced += 1;
          if (r.linkedin?.work_history_rows) linkedinSummary.work_history_rows += r.linkedin.work_history_rows;
        }
        processedTotal += chunkResults.length;
        changedTotal += chunkResults.filter((r) => r.updated.length > 0).length;
        failedTotal += chunkResults.filter((r) => !r.ok).length;

        // Persist after each chunk so the polling UI sees progress.
        await supabase.from("enrichment_jobs").update({
          processed: processedTotal,
          changed: changedTotal,
          failed: failedTotal,
          credits,
          linkedin_summary: linkedinSummary,
          results: accumulatedResults,
        }).eq("id", jobId);
      }

      await supabase.from("enrichment_jobs").update({
        status: "completed",
        finished_at: new Date().toISOString(),
      }).eq("id", jobId);

      return {
        ok: true,
        processed: processedTotal,
        changed: changedTotal,
        failed: failedTotal,
      };
    } catch (err: any) {
      const message = err?.message ?? "unknown error";
      await supabase.from("enrichment_jobs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: message.slice(0, 500),
      }).eq("id", jobId);
      await notifyError({
        taskId: "process-enrichment-job",
        error: err,
        context: { jobId, processed: processedTotal, total: job.total },
      });
      return { ok: false, error: message };
    }
  },
);
