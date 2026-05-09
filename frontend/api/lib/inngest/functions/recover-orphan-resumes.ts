import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";

/**
 * One-shot recovery for résumé files that landed in storage but never
 * got a `resumes` row. Caused by a stale parse_status / parsing_status
 * column-name mismatch (since fixed) — the file landed in storage but
 * the resumes insert silently failed.
 *
 * Walks the orphans returned by the `list_orphan_resume_files` RPC,
 * creates a stub candidate + resumes row for each, and fires
 * `ai/resume-ingestion.requested`. The post-parse smart-redirect in
 * the ingestion path then matches by parsed email / LinkedIn slug,
 * re-points the resume row to the existing candidate, and dissolves
 * the placeholder stub.
 *
 * Manual one-off — fire from the Inngest dashboard or via:
 *   await inngest.send({
 *     name: "ops/recover-orphan-resumes.requested",
 *     data: { limit: 500, since: "2026-04-15" },
 *   });
 *
 * Ported from `src/trigger/recover-orphan-resumes.ts`.
 */
interface RecoverPayload {
  limit?: number;
  since?: string;
}

export const recoverOrphanResumes = inngest.createFunction(
  { id: "recover-orphan-resumes", name: "Recover orphaned resume files (Inngest)", retries: 1 },
  { event: "ops/recover-orphan-resumes.requested" },
  async ({ event, logger }) => {
    const payload = (event.data ?? {}) as RecoverPayload;
    const supabase = getSupabaseAdmin();
    const limit = payload.limit ?? 200;
    const since = payload.since ?? "2026-04-15";

    const { data: orphansRaw, error } = await supabase
      .rpc("list_orphan_resume_files", { p_since: since, p_limit: limit });
    if (error) throw new Error(`list_orphan_resume_files failed: ${error.message}`);
    const orphans = (orphansRaw ?? []) as unknown as Array<{ name: string; created_at: string }>;

    logger.info("Orphan recovery starting", { count: orphans.length, since, limit });

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    const ingestionEvents: Array<{
      name: "ai/resume-ingestion.requested";
      data: { resumeId: string; candidateId: string; filePath: string; fileName: string };
    }> = [];

    for (const orphan of orphans) {
      const filePath = orphan.name;
      const segs = filePath.split("/");
      let owner_user_id: string | null = null;
      let fileName = segs[segs.length - 1] || "resume";
      fileName = fileName.replace(/^\d+_/, "");

      if (/^[0-9a-f-]{36}$/i.test(segs[0]) && segs[0] !== "inbox") {
        owner_user_id = segs[0];
      }

      try {
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
            filePath,
            candidateId: stub.id,
            error: resumeErr?.message,
          });
          await supabase.from("people").delete().eq("id", stub.id);
          errors++;
          continue;
        }

        ingestionEvents.push({
          name: "ai/resume-ingestion.requested",
          data: {
            resumeId: resume.id,
            candidateId: stub.id,
            filePath,
            fileName,
          },
        });

        processed++;
        logger.info("Queued orphan for ingestion", { filePath, resumeId: resume.id });
      } catch (err: any) {
        errors++;
        logger.warn("Recovery error (non-fatal)", { filePath, error: err.message });
      }
    }

    if (ingestionEvents.length > 0) {
      // Inngest accepts up to 5000 events per send; chunk at 500 to stay
      // comfortably under the network buffer.
      const chunkSize = 500;
      for (let i = 0; i < ingestionEvents.length; i += chunkSize) {
        await inngest.send(ingestionEvents.slice(i, i + chunkSize));
      }
    }

    const summary = { processed, skipped, errors };
    logger.info("Orphan recovery batch complete", summary);
    return summary;
  },
);
