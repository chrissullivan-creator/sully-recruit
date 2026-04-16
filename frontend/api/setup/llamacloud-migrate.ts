import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getOrCreateResumePipeline,
  uploadResumeToCloud,
  createSupabaseAdmin,
} from "../lib/llamaindex";

/**
 * POST /api/setup/llamacloud-migrate
 *
 * One-time migration script to upload existing resume chunks from Supabase
 * to LlamaCloud for search indexing. Run this after setting up LLAMA_CLOUD_API_KEY.
 *
 * Processes in batches of 50 resumes to avoid timeouts.
 * Call repeatedly until it returns { done: true }.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.LLAMA_CLOUD_API_KEY) {
    return res.status(500).json({ error: "LLAMA_CLOUD_API_KEY not configured" });
  }

  const supabase = createSupabaseAdmin();
  const batchSize = parseInt((req.query.batch_size as string) || "50");
  const offset = parseInt((req.query.offset as string) || "0");

  try {
    // Get pipeline ID
    const pipelineId = await getOrCreateResumePipeline();

    // Fetch resume chunks grouped by resume_id, with candidate info
    const { data: resumes, error: resumeErr } = await supabase
      .from("resumes")
      .select("id, candidate_id, candidates!inner(full_name)")
      .eq("parsing_status", "completed")
      .order("created_at", { ascending: true })
      .range(offset, offset + batchSize - 1) as any;

    if (resumeErr) throw resumeErr;
    if (!resumes || resumes.length === 0) {
      return res.status(200).json({
        done: true,
        message: "All resumes migrated to LlamaCloud",
        totalProcessed: offset,
      });
    }

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const resume of resumes) {
      try {
        // Get chunks for this resume from resume_embeddings table
        const { data: chunks } = await supabase
          .from("resume_embeddings")
          .select("chunk_text, chunk_index")
          .eq("resume_id", resume.id)
          .order("chunk_index", { ascending: true });

        if (!chunks || chunks.length === 0) {
          skipped++;
          continue;
        }

        const chunkTexts = chunks.map((c: any) => c.chunk_text).filter(Boolean);
        if (chunkTexts.length === 0) {
          skipped++;
          continue;
        }

        const candidateName = (resume as any).candidates?.full_name || "";

        await uploadResumeToCloud(
          pipelineId,
          resume.candidate_id,
          resume.id,
          chunkTexts,
          candidateName,
        );

        uploaded++;
      } catch (err: any) {
        console.error(`Failed to upload resume ${resume.id}:`, err.message);
        failed++;
      }
    }

    return res.status(200).json({
      done: resumes.length < batchSize,
      batch: { uploaded, skipped, failed },
      nextOffset: offset + batchSize,
      message: `Processed ${resumes.length} resumes. Call again with offset=${offset + batchSize} to continue.`,
    });
  } catch (err: any) {
    console.error("LlamaCloud migration error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
