import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { resumeIngestion } from "./resume-ingestion";

/**
 * One-shot recovery for résumé files that landed in storage but
 * never got a `resumes` row.
 *
 * Cause (now fixed): every dashboard / bulk-add / forwarder upload
 * inserted into the resumes table with `parse_status` instead of
 * `parsing_status`. Postgres rejected the column, the surrounding
 * try/catch turned the error into a console.warn, and the file was
 * orphaned in storage with no DB pointer. Resume-ingestion never ran.
 *
 * Recovery strategy:
 *   1. Find every storage object in the `resumes` bucket whose
 *      file_path does not appear on any resumes row.
 *   2. For each orphan, create a stub candidate (owner = the user
 *      whose folder the file lives under — the path encodes
 *      `{userId}/{ts}_filename`) plus a fresh resumes row pointing
 *      to it. is_stub=true tags it so resume-ingestion's smart-
 *      redirect can drop the stub if the parsed candidate already
 *      exists in the DB.
 *   3. Dispatch resume-ingestion. The post-parse redirect logic
 *      added with the forwarder fix will:
 *        - Match by parsed email (across personal/work/primary) +
 *          LinkedIn URL slug
 *        - Re-point the resumes row to the matched candidate
 *        - Delete the stub (only when it's a stub with no other
 *          resumes attached)
 *      If no match, the stub becomes the candidate and gets filled
 *      in from parsed_json.
 *
 * Dispatch from the Trigger.dev dashboard with no payload (defaults
 * to processing the 200 oldest orphans). Override with
 *   { limit: 500, since: "2026-04-15" }
 * for a wider sweep.
 */

interface RecoverPayload {
  /** Hard cap so we don't blow through Anthropic / Gemini budget on
   *  one run. Default 200. */
  limit?: number;
  /** Only consider storage objects created on or after this ISO date.
   *  Default "2026-04-15" (around when the bug started). */
  since?: string;
}

export const recoverOrphanResumes = task({
  id: "recover-orphan-resumes",
  maxDuration: 540,
  retry: { maxAttempts: 1 },
  run: async (payload: RecoverPayload) => {
    const supabase = getSupabaseAdmin();
    const limit = payload.limit ?? 200;
    const since = payload.since ?? "2026-04-15";

    // Find orphans — storage objects in `resumes` bucket whose path
    // doesn't appear on any resumes row.
    const { data: orphans, error } = await supabase
      .rpc("list_orphan_resume_files", { p_since: since, p_limit: limit })
      .returns<Array<{ name: string; created_at: string }>>();
    if (error) throw new Error(`list_orphan_resume_files failed: ${error.message}`);

    logger.info("Orphan recovery starting", { count: orphans?.length ?? 0, since, limit });
    return await processOrphans(supabase, orphans ?? []);
  },
});

async function processOrphans(
  supabase: any,
  orphans: Array<{ name: string; created_at: string }>,
): Promise<{ processed: number; skipped: number; errors: number }> {
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const orphan of orphans) {
    const filePath = orphan.name;
    // Path shape: `{userId}/{timestamp}_{originalName}` for dashboard
    // uploads, or `inbox/{candidateId}/{ts}_{name}` for forwards.
    const segs = filePath.split("/");
    let owner_user_id: string | null = null;
    let fileName = segs[segs.length - 1] || "resume";
    fileName = fileName.replace(/^\d+_/, ""); // strip the `${ts}_` prefix

    if (/^[0-9a-f-]{36}$/i.test(segs[0]) && segs[0] !== "inbox") {
      owner_user_id = segs[0];
    }

    try {
      // 1. Create a stub candidate. resume-ingestion's smart-redirect
      //    will dissolve this stub if the parsed candidate matches
      //    someone already on file.
      const { data: stub, error: stubErr } = await supabase
        .from("people")
        .insert({
          type: "candidate",
          full_name: "Pending résumé recovery",
          status: "new",
          source: "orphan_recovery",
          source_detail: filePath,
          is_stub: true,
          owner_user_id,
          created_by_user_id: owner_user_id,
        } as any)
        .select("id")
        .single();
      if (stubErr || !stub?.id) {
        logger.warn("Recovery: failed to create stub", { filePath, error: stubErr?.message });
        errors++;
        continue;
      }

      // 2. Create the missing resumes row.
      const mimeType = fileName.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : fileName.toLowerCase().endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/octet-stream";
      const { data: resume, error: resumeErr } = await supabase
        .from("resumes")
        .insert({
          candidate_id: stub.id,
          file_path: filePath,
          file_name: fileName,
          mime_type: mimeType,
          parsing_status: "pending",
          source: "orphan_recovery",
        } as any)
        .select("id")
        .single();
      if (resumeErr || !resume?.id) {
        logger.warn("Recovery: failed to create resumes row", {
          filePath, candidateId: stub.id, error: resumeErr?.message,
        });
        // Roll back the stub so we don't litter people with empties.
        await supabase.from("people").delete().eq("id", stub.id);
        errors++;
        continue;
      }

      // 3. Dispatch ingestion — Gemini parse → smart-redirect → fill.
      await resumeIngestion.trigger({
        resumeId: resume.id,
        candidateId: stub.id,
        filePath,
        fileName,
      });

      processed++;
      logger.info("Queued orphan for ingestion", { filePath, resumeId: resume.id });
    } catch (err: any) {
      errors++;
      logger.warn("Recovery error (non-fatal)", { filePath, error: err.message });
    }
  }

  const summary = { processed, skipped, errors };
  logger.info("Orphan recovery batch complete", summary);
  return summary;
}
