import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { getMicrosoftAccessToken, createOrUpdateOutlookContact } from "./lib/microsoft-graph";
import type { CandidateContactData } from "./lib/microsoft-graph";

/**
 * Sync a candidate's contact info to the owner's Microsoft Outlook contacts.
 *
 * Triggered by DB triggers on:
 *   - candidates (AFTER INSERT)
 *   - sequence_enrollments (AFTER INSERT)
 *   - task_links (AFTER INSERT, meeting tasks only)
 *
 * Idempotent: if the candidate already has an ms_contact_id, the existing
 * Outlook contact is updated rather than creating a duplicate.
 */
export const syncOutlookContact = task({
  id: "sync-outlook-contact",
  retry: { maxAttempts: 3 },
  run: async (payload: { candidateId: string }) => {
    const { candidateId } = payload;
    const supabase = getSupabaseAdmin();

    // 1. Fetch candidate data
    const { data: candidate, error } = await supabase
      .from("candidates")
      .select(
        "id, first_name, last_name, full_name, email, phone, current_title, current_company, linkedin_url, owner_id, ms_contact_id",
      )
      .eq("id", candidateId)
      .single();

    if (error || !candidate) {
      logger.warn("Candidate not found, skipping sync", { candidateId, error: error?.message });
      return { skipped: true, reason: "candidate_not_found" };
    }

    // 2. Resolve owner email from profiles table
    const ownerId = candidate.owner_id;
    if (!ownerId) {
      logger.warn("Candidate has no owner_id, skipping sync", { candidateId });
      return { skipped: true, reason: "no_owner" };
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", ownerId)
      .maybeSingle();

    if (!profile?.email) {
      logger.warn("Owner has no email in profiles, skipping sync", { ownerId });
      return { skipped: true, reason: "no_owner_email" };
    }

    const ownerEmail = profile.email;

    // 3. Build contact data
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

    // 4. Get Microsoft access token and sync
    const accessToken = await getMicrosoftAccessToken();
    const contactId = await createOrUpdateOutlookContact(
      accessToken,
      ownerEmail,
      contactData,
      candidate.ms_contact_id,
    );

    // 5. Store the Graph contact ID for dedup
    await supabase
      .from("candidates")
      .update({
        ms_contact_id: contactId,
        ms_contact_synced_at: new Date().toISOString(),
      })
      .eq("id", candidateId);

    logger.info("Candidate synced to Outlook contacts", {
      candidateId,
      ownerEmail,
      contactId,
      wasUpdate: !!candidate.ms_contact_id,
    });

    return { synced: true, contactId, ownerEmail };
  },
});
