import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import {
  buildProfileText,
  getVoyageEmbedding,
  delay,
} from "./lib/resume-parsing";

/**
 * Backfill resume embeddings for candidates who have parsed resumes
 * but no full_profile embedding yet.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: backfill-resume-embeddings
 *   Cron: as needed (one-shot or scheduled)
 */

export const backfillResumeEmbeddings = schedules.task({
  id: "backfill-resume-embeddings",
  maxDuration: 300,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const BATCH_SIZE = 25;

    // Find resumes that are parsed but have no full_profile embedding
    const { data: resumes, error } = await supabase
      .from("resumes")
      .select("id, candidate_id, raw_text")
      .eq("parsing_status", "completed")
      .not("raw_text", "is", null)
      .neq("raw_text", "")
      .neq("raw_text", "[PDF - parsed via Claude document API]")
      .not("candidate_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) throw new Error(`Query error: ${error.message}`);

    // Filter out candidates that already have a full_profile embedding
    const candidateIds = [...new Set((resumes ?? []).map((r) => r.candidate_id!))];
    let existingEmbeddedIds = new Set<string>();

    if (candidateIds.length > 0) {
      const { data: existing } = await supabase
        .from("resume_embeddings")
        .select("candidate_id")
        .in("candidate_id", candidateIds)
        .eq("embed_type", "full_profile");

      existingEmbeddedIds = new Set((existing ?? []).map((e) => e.candidate_id));
    }

    const toProcess = (resumes ?? []).filter(
      (r) => !existingEmbeddedIds.has(r.candidate_id!)
    );

    if (toProcess.length === 0) {
      logger.info("No candidates need embedding backfill");
      return { processed: 0, embedded: 0, skipped: 0, remaining: 0 };
    }

    let processed = 0;
    let embedded = 0;
    let skipped = 0;

    for (let i = 0; i < toProcess.length; i++) {
      const resume = toProcess[i];
      processed++;

      try {
        // Fetch candidate data
        const { data: candidate } = await supabase
          .from("people")
          .select("id, full_name, current_title, current_company, location_text, skills")
          .eq("id", resume.candidate_id!)
          .single();

        if (!candidate) {
          logger.warn("Candidate not found", { candidateId: resume.candidate_id });
          skipped++;
          continue;
        }

        const profileText = buildProfileText(candidate, resume.raw_text, null);

        if (profileText.trim().length < 50) {
          logger.info("Profile text too short, skipping", {
            candidateId: candidate.id,
            length: profileText.trim().length,
          });
          skipped++;
          continue;
        }

        const embedding = await getVoyageEmbedding(profileText);

        // Upsert: delete existing then insert
        await supabase
          .from("resume_embeddings")
          .delete()
          .eq("candidate_id", candidate.id)
          .eq("embed_type", "full_profile");

        await supabase.from("resume_embeddings").insert({
          candidate_id: candidate.id,
          resume_id: resume.id,
          embedding: JSON.stringify(embedding),
          source_text: profileText.slice(0, 2000),
          chunk_text: profileText.slice(0, 2000),
          chunk_index: 0,
          embed_type: "full_profile",
          embed_model: "voyage-finance-2",
        });

        embedded++;
        logger.info("Embedded candidate", {
          candidateId: candidate.id,
          progress: `${i + 1}/${toProcess.length}`,
        });
      } catch (err: any) {
        logger.error("Failed to embed candidate", {
          candidateId: resume.candidate_id,
          error: err?.message ?? "unknown",
        });
        skipped++;
      }

      // 500ms delay between candidates
      if (i < toProcess.length - 1) await delay(500);
    }

    // Query remaining count of candidates still missing embeddings
    const { count: remainingCount } = await supabase
      .from("resumes")
      .select("id, candidate_id", { count: "exact", head: true })
      .eq("parsing_status", "completed")
      .not("raw_text", "is", null)
      .neq("raw_text", "")
      .neq("raw_text", "[PDF - parsed via Claude document API]")
      .not("candidate_id", "is", null);

    // Subtract the ones we know have embeddings now
    const { count: embeddedTotal } = await supabase
      .from("resume_embeddings")
      .select("candidate_id", { count: "exact", head: true })
      .eq("embed_type", "full_profile");

    const remaining = Math.max(0, (remainingCount ?? 0) - (embeddedTotal ?? 0));

    logger.info("Backfill complete", { processed, embedded, skipped, remaining });
    return { processed, embedded, skipped, remaining };
  },
});
