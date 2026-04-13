import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { getMicrosoftAccessToken, createOrUpdateOutlookContact } from "./lib/microsoft-graph";
import type { CandidateContactData } from "./lib/microsoft-graph";

const BATCH_SIZE = 50;
const DELAY_MS = 250; // ~4 requests/second to stay under Graph API throttling

/**
 * One-time backfill: sync existing candidates to Outlook contacts.
 *
 * Targets candidates who:
 *   - Don't already have an ms_contact_id (not yet synced)
 *   - Are enrolled in a sequence OR linked to a meeting task
 *
 * Trigger manually from Trigger.dev dashboard or via
 * POST /api/trigger-backfill-outlook-contacts
 */
export const backfillOutlookContacts = task({
  id: "backfill-outlook-contacts",
  retry: { maxAttempts: 1 },
  run: async () => {
    const supabase = getSupabaseAdmin();
    const stats = { total: 0, synced: 0, skipped: 0, failed: 0 };

    // Find candidates in sequences or with meeting task links, not yet synced
    const { data: candidates, error } = await supabase.rpc("get_unsynced_outlook_candidates");

    // If the RPC doesn't exist yet, fall back to a manual query
    let toSync = candidates;
    if (error || !candidates) {
      logger.info("RPC not found, using fallback query");

      // Candidates in sequences
      const { data: enrolledIds } = await supabase
        .from("sequence_enrollments")
        .select("candidate_id")
        .not("candidate_id", "is", null);

      // Candidates linked to meeting tasks
      const { data: meetingLinks } = await supabase
        .from("task_links")
        .select("entity_id, tasks!inner(task_type)")
        .eq("entity_type", "candidate")
        .eq("tasks.task_type", "meeting");

      // Combine unique candidate IDs
      const idSet = new Set<string>();
      for (const row of enrolledIds || []) {
        if (row.candidate_id) idSet.add(row.candidate_id);
      }
      for (const row of meetingLinks || []) {
        if (row.entity_id) idSet.add(row.entity_id);
      }

      if (idSet.size === 0) {
        logger.info("No candidates to backfill");
        return stats;
      }

      // Fetch candidate data for those not yet synced
      const { data: unsyncedCandidates } = await supabase
        .from("candidates")
        .select(
          "id, first_name, last_name, full_name, email, phone, current_title, current_company, linkedin_url, owner_id, ms_contact_id",
        )
        .in("id", Array.from(idSet))
        .is("ms_contact_id", null)
        .limit(BATCH_SIZE * 10);

      toSync = unsyncedCandidates;
    }

    if (!toSync || toSync.length === 0) {
      logger.info("No candidates to backfill");
      return stats;
    }

    stats.total = toSync.length;
    logger.info(`Backfilling ${stats.total} candidates to Outlook contacts`);

    // Process in batches
    for (let i = 0; i < toSync.length; i++) {
      const candidate = toSync[i];

      try {
        if (!candidate.owner_id) {
          stats.skipped++;
          continue;
        }

        // Resolve owner email
        const { data: profile } = await supabase
          .from("profiles")
          .select("email")
          .eq("id", candidate.owner_id)
          .maybeSingle();

        if (!profile?.email) {
          stats.skipped++;
          continue;
        }

        const contactData: CandidateContactData = {
          first_name: candidate.first_name,
          last_name: candidate.last_name,
          full_name: candidate.full_name,
          email: candidate.email,
          phone: candidate.phone,
          current_title: candidate.current_title,
          current_company: candidate.current_company,
          linkedin_url: candidate.linkedin_url,
        };

        const accessToken = await getMicrosoftAccessToken();
        const contactId = await createOrUpdateOutlookContact(
          accessToken,
          profile.email,
          contactData,
          candidate.ms_contact_id,
        );

        await supabase
          .from("candidates")
          .update({
            ms_contact_id: contactId,
            ms_contact_synced_at: new Date().toISOString(),
          })
          .eq("id", candidate.id);

        stats.synced++;

        // Throttle to avoid Graph API rate limits
        if (i < toSync.length - 1) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      } catch (err: any) {
        logger.error("Failed to sync candidate", {
          candidateId: candidate.id,
          error: err.message,
        });
        stats.failed++;
      }
    }

    logger.info("Backfill complete", stats);
    return stats;
  },
});
