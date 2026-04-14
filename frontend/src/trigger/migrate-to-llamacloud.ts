import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getLlamaCloudKey } from "./lib/supabase";

/**
 * Trigger.dev task: Migrate all existing resume data to LlamaCloud.
 *
 * Iterates through all parsed resumes, reads their chunks from resume_chunks,
 * and uploads them to the LlamaCloud managed pipeline for RAG search.
 *
 * This is a one-time migration — after running, all new resumes are automatically
 * indexed via the resume-ingestion task.
 */
export const migrateToLlamaCloud = task({
  id: "migrate-to-llamacloud",
  retry: {
    maxAttempts: 2,
  },
  run: async () => {
    const supabase = getSupabaseAdmin();
    const llamaKey = await getLlamaCloudKey();

    // Dynamically import the LlamaCloud helpers (they live in the API layer)
    // We set the env var so the lib can pick it up
    process.env.LLAMA_CLOUD_API_KEY = llamaKey;
    process.env.SUPABASE_URL = process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getOrCreateResumePipeline, uploadResumeToCloud } = await import(
      "../../api/lib/llamaindex"
    );

    // Step 1: Get or create the LlamaCloud pipeline
    logger.info("Getting or creating LlamaCloud pipeline...");
    const pipelineId = await getOrCreateResumePipeline();
    logger.info("Pipeline ready", { pipelineId });

    // Step 2: Count total resumes to migrate
    const { count: totalResumes } = await supabase
      .from("resumes")
      .select("id", { count: "exact", head: true })
      .eq("parse_status", "completed");

    logger.info("Total resumes to migrate", { total: totalResumes });

    if (!totalResumes || totalResumes === 0) {
      logger.info("No resumes to migrate");
      return { success: true, total: 0, uploaded: 0, skipped: 0, failed: 0 };
    }

    // Step 3: Process in batches
    const BATCH_SIZE = 50;
    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let offset = 0; offset < totalResumes; offset += BATCH_SIZE) {
      logger.info(`Processing batch ${Math.floor(offset / BATCH_SIZE) + 1}`, {
        offset,
        total: totalResumes,
      });

      const { data: resumes } = (await supabase
        .from("resumes")
        .select("id, candidate_id, candidates!inner(full_name)")
        .eq("parse_status", "completed")
        .order("created_at", { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1)) as any;

      if (!resumes || resumes.length === 0) break;

      for (const resume of resumes) {
        try {
          // Get chunks for this resume
          const { data: chunks } = await supabase
            .from("resume_chunks")
            .select("content, chunk_index")
            .eq("resume_id", resume.id)
            .order("chunk_index", { ascending: true });

          if (!chunks || chunks.length === 0) {
            skipped++;
            continue;
          }

          const chunkTexts = chunks
            .map((c: any) => c.content)
            .filter(Boolean);

          if (chunkTexts.length === 0) {
            skipped++;
            continue;
          }

          const candidateName = resume.candidates?.full_name || "";

          await uploadResumeToCloud(
            pipelineId,
            resume.candidate_id,
            resume.id,
            chunkTexts,
            candidateName,
          );

          uploaded++;
        } catch (err: any) {
          logger.error(`Failed to upload resume ${resume.id}`, {
            error: err.message,
          });
          failed++;
        }
      }

      logger.info(`Batch complete`, {
        uploaded,
        skipped,
        failed,
        progress: `${offset + resumes.length}/${totalResumes}`,
      });
    }

    // Step 4: Log summary
    const summary = {
      success: true,
      total: totalResumes,
      uploaded,
      skipped,
      failed,
      pipelineId,
    };

    logger.info("Migration complete", summary);
    return summary;
  },
});
