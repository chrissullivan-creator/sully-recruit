import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize an email: lowercase + trim */
function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || !email.trim()) return null;
  return email.trim().toLowerCase();
}

/** Normalize phone: strip non-digits, take last 10 digits */
function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null; // too short to be a real phone
  return digits.slice(-10);
}

/** Extract LinkedIn slug from URL: /in/slug */
function extractLinkedInSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/in\/([a-zA-Z0-9_-]+)/);
  return match ? match[1].toLowerCase() : null;
}

/** Ensure candidate_id_a < candidate_id_b for consistent UNIQUE constraint */
function orderedPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

// ─────────────────────────────────────────────────────────────────────────────
// Task A: scan-duplicate-candidates
// ─────────────────────────────────────────────────────────────────────────────

export const scanDuplicateCandidates = task({
  id: "scan-duplicate-candidates",
  retry: { maxAttempts: 2 },
  run: async () => {
    const supabase = getSupabaseAdmin();
    logger.info("Starting full duplicate candidate scan");

    // Fetch all candidates
    const { data: candidates, error: fetchErr } = await supabase
      .from("candidates")
      .select("id, email, phone, linkedin_url, first_name, last_name, company");

    if (fetchErr || !candidates) {
      logger.error("Failed to fetch candidates", { error: fetchErr?.message });
      throw new Error(`Failed to fetch candidates: ${fetchErr?.message}`);
    }

    logger.info(`Fetched ${candidates.length} candidates for dedup scan`);

    // Fetch existing non-pending pairs so we skip them
    const { data: existingPairs, error: existErr } = await supabase
      .from("duplicate_candidates")
      .select("candidate_id_a, candidate_id_b, status")
      .in("status", ["merged", "dismissed"]);

    if (existErr) {
      logger.warn("Failed to fetch existing pairs, continuing anyway", { error: existErr.message });
    }

    const skipSet = new Set<string>();
    for (const pair of existingPairs || []) {
      skipSet.add(`${pair.candidate_id_a}:${pair.candidate_id_b}`);
    }

    // Collect duplicate pairs: Map<"idA:idB", { matchType, matchValue, confidence }>
    const duplicates = new Map<string, { matchType: string; matchValue: string | null; confidence: number }>();

    function addPair(idA: string, idB: string, matchType: string, matchValue: string | null, confidence: number) {
      const [a, b] = orderedPair(idA, idB);
      const key = `${a}:${b}`;
      if (skipSet.has(key)) return;
      // Keep the highest-confidence match
      const existing = duplicates.get(key);
      if (!existing || confidence > existing.confidence) {
        duplicates.set(key, { matchType, matchValue, confidence });
      }
    }

    // --- Group by exact email match ---
    const emailMap = new Map<string, string[]>();
    for (const c of candidates) {
      const email = normalizeEmail(c.email);
      if (!email) continue;
      const list = emailMap.get(email) || [];
      list.push(c.id);
      emailMap.set(email, list);
    }
    for (const [email, ids] of emailMap) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addPair(ids[i], ids[j], "email", email, 1.0);
        }
      }
    }

    // --- Group by normalized phone ---
    const phoneMap = new Map<string, string[]>();
    for (const c of candidates) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;
      const list = phoneMap.get(phone) || [];
      list.push(c.id);
      phoneMap.set(phone, list);
    }
    for (const [phone, ids] of phoneMap) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addPair(ids[i], ids[j], "phone", phone, 1.0);
        }
      }
    }

    // --- Group by LinkedIn slug ---
    const linkedinMap = new Map<string, string[]>();
    for (const c of candidates) {
      const slug = extractLinkedInSlug(c.linkedin_url);
      if (!slug) continue;
      const list = linkedinMap.get(slug) || [];
      list.push(c.id);
      linkedinMap.set(slug, list);
    }
    for (const [slug, ids] of linkedinMap) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addPair(ids[i], ids[j], "linkedin", slug, 1.0);
        }
      }
    }

    logger.info(`Found ${duplicates.size} duplicate pairs to upsert`);

    // Upsert all pairs into duplicate_candidates
    let newCount = 0;
    for (const [key, info] of duplicates) {
      const [candidateIdA, candidateIdB] = key.split(":");
      const { error: upsertErr } = await supabase
        .from("duplicate_candidates")
        .upsert(
          {
            candidate_id_a: candidateIdA,
            candidate_id_b: candidateIdB,
            match_type: info.matchType,
            match_value: info.matchValue,
            confidence: info.confidence,
            status: "pending",
          },
          { onConflict: "candidate_id_a,candidate_id_b", ignoreDuplicates: true }
        );

      if (upsertErr) {
        logger.warn("Failed to upsert duplicate pair", {
          candidateIdA,
          candidateIdB,
          error: upsertErr.message,
        });
      } else {
        newCount++;
      }
    }

    logger.info("Duplicate scan complete", { totalPairs: duplicates.size, upserted: newCount });
    return { totalPairs: duplicates.size, upserted: newCount };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Task B: check-new-candidate-dedup
// ─────────────────────────────────────────────────────────────────────────────

interface CheckNewCandidateDedupPayload {
  candidateId: string;
}

export const checkNewCandidateDedup = task({
  id: "check-new-candidate-dedup",
  retry: { maxAttempts: 3 },
  run: async (payload: CheckNewCandidateDedupPayload) => {
    const { candidateId } = payload;
    const supabase = getSupabaseAdmin();

    logger.info("Checking new candidate for duplicates", { candidateId });

    // Fetch the new candidate
    const { data: candidate, error: fetchErr } = await supabase
      .from("candidates")
      .select("id, email, phone, linkedin_url, first_name, last_name, company")
      .eq("id", candidateId)
      .single();

    if (fetchErr || !candidate) {
      logger.error("Failed to fetch candidate", { candidateId, error: fetchErr?.message });
      throw new Error(`Candidate not found: ${candidateId}`);
    }

    const email = normalizeEmail(candidate.email);
    const phone = normalizePhone(candidate.phone);
    const linkedinSlug = extractLinkedInSlug(candidate.linkedin_url);

    // Collect all matches with their type and confidence
    const matches: { id: string; matchType: string; matchValue: string | null; confidence: number }[] = [];

    // --- Email match ---
    if (email) {
      const { data: emailMatches } = await supabase
        .from("candidates")
        .select("id, email")
        .neq("id", candidateId)
        .ilike("email", email);

      for (const m of emailMatches || []) {
        if (normalizeEmail(m.email) === email) {
          matches.push({ id: m.id, matchType: "email", matchValue: email, confidence: 1.0 });
        }
      }
    }

    // --- Phone match ---
    if (phone) {
      const { data: allCandidates } = await supabase
        .from("candidates")
        .select("id, phone")
        .neq("id", candidateId)
        .not("phone", "is", null);

      for (const m of allCandidates || []) {
        if (normalizePhone(m.phone) === phone) {
          matches.push({ id: m.id, matchType: "phone", matchValue: phone, confidence: 1.0 });
        }
      }
    }

    // --- LinkedIn match ---
    if (linkedinSlug) {
      const { data: linkedinMatches } = await supabase
        .from("candidates")
        .select("id, linkedin_url")
        .neq("id", candidateId)
        .not("linkedin_url", "is", null);

      for (const m of linkedinMatches || []) {
        if (extractLinkedInSlug(m.linkedin_url) === linkedinSlug) {
          matches.push({ id: m.id, matchType: "linkedin", matchValue: linkedinSlug, confidence: 1.0 });
        }
      }
    }

    // Deduplicate matches by candidate id (keep highest confidence)
    const uniqueMatches = new Map<string, typeof matches[0]>();
    for (const m of matches) {
      const existing = uniqueMatches.get(m.id);
      if (!existing || m.confidence > existing.confidence) {
        uniqueMatches.set(m.id, m);
      }
    }

    const dedupedMatches = Array.from(uniqueMatches.values());
    logger.info(`Found ${dedupedMatches.length} matches for candidate ${candidateId}`);

    if (dedupedMatches.length === 0) {
      logger.info("No duplicates found", { candidateId });
      return { action: "none", candidateId };
    }

    // If exactly ONE match with exact confidence, auto-merge
    if (dedupedMatches.length === 1 && dedupedMatches[0].confidence >= 1.0) {
      const match = dedupedMatches[0];
      logger.info("Exact single match found, triggering auto-merge", {
        candidateId,
        matchId: match.id,
        matchType: match.matchType,
      });

      // The existing candidate is the survivor (they were here first)
      const { mergeCandidates } = await import("./candidate-dedup");
      await mergeCandidates.trigger({
        survivorId: match.id,
        mergedId: candidateId,
      });

      return { action: "auto_merged", candidateId, survivorId: match.id, matchType: match.matchType };
    }

    // Multiple matches: insert into duplicate_candidates for manual review
    logger.info("Multiple matches found, inserting for manual review", {
      candidateId,
      matchCount: dedupedMatches.length,
    });

    for (const match of dedupedMatches) {
      const [a, b] = orderedPair(candidateId, match.id);
      const { error: insertErr } = await supabase
        .from("duplicate_candidates")
        .upsert(
          {
            candidate_id_a: a,
            candidate_id_b: b,
            match_type: match.matchType,
            match_value: match.matchValue,
            confidence: match.confidence,
            status: "pending",
          },
          { onConflict: "candidate_id_a,candidate_id_b", ignoreDuplicates: true }
        );

      if (insertErr) {
        logger.warn("Failed to insert duplicate pair", {
          candidateIdA: a,
          candidateIdB: b,
          error: insertErr.message,
        });
      }
    }

    return { action: "manual_review", candidateId, matchCount: dedupedMatches.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Task C: merge-candidates
// ─────────────────────────────────────────────────────────────────────────────

interface MergeCandidatesPayload {
  survivorId: string;
  mergedId: string;
  mergedBy?: string;
}

export const mergeCandidates = task({
  id: "merge-candidates",
  retry: { maxAttempts: 2 },
  run: async (payload: MergeCandidatesPayload) => {
    const { survivorId, mergedId, mergedBy } = payload;
    const supabase = getSupabaseAdmin();

    logger.info("Starting candidate merge", { survivorId, mergedId, mergedBy });

    // ── 1. Fetch both candidate records ──────────────────────────────
    const { data: survivor, error: sErr } = await supabase
      .from("candidates")
      .select("*")
      .eq("id", survivorId)
      .single();

    if (sErr || !survivor) {
      logger.error("Survivor candidate not found", { survivorId, error: sErr?.message });
      throw new Error(`Survivor candidate not found: ${survivorId}`);
    }

    const { data: merged, error: mErr } = await supabase
      .from("candidates")
      .select("*")
      .eq("id", mergedId)
      .single();

    if (mErr || !merged) {
      logger.error("Merged candidate not found", { mergedId, error: mErr?.message });
      throw new Error(`Merged candidate not found: ${mergedId}`);
    }

    // ── 2. Snapshot merged candidate into merge log ──────────────────
    const tablesUpdated: Record<string, number> = {};

    // ── 3. Fill empty fields on survivor from merged candidate ───────
    const fieldsToFill: string[] = [
      "email",
      "phone",
      "linkedin_url",
      "title",
      "company",
      "location_text",
      "source",
    ];

    const updates: Record<string, any> = {};
    for (const field of fieldsToFill) {
      const survivorVal = survivor[field];
      const mergedVal = merged[field];
      // Fill if survivor field is empty/null and merged has a value
      if ((!survivorVal || survivorVal === "") && mergedVal && mergedVal !== "") {
        updates[field] = mergedVal;
      }
    }

    // Append notes
    if (merged.notes && merged.notes.trim()) {
      if (survivor.notes && survivor.notes.trim()) {
        updates.notes = `${survivor.notes}\n\n--- Merged from duplicate ---\n${merged.notes}`;
      } else {
        updates.notes = merged.notes;
      }
    }

    // Union skills arrays
    const survivorSkills: string[] = survivor.skills || [];
    const mergedSkills: string[] = merged.skills || [];
    const unionSkills = Array.from(new Set([...survivorSkills, ...mergedSkills]));
    if (unionSkills.length > survivorSkills.length) {
      updates.skills = unionSkills;
    }

    if (Object.keys(updates).length > 0) {
      const { error: updateErr } = await supabase
        .from("candidates")
        .update(updates)
        .eq("id", survivorId);

      if (updateErr) {
        logger.error("Failed to update survivor candidate fields", { error: updateErr.message });
        throw new Error(`Failed to update survivor: ${updateErr.message}`);
      }
      logger.info("Updated survivor candidate fields", { fields: Object.keys(updates) });
    }

    // ── 4. Reassign related records ──────────────────────────────────

    // conversations
    const { count: convCount, error: convErr } = await supabase
      .from("conversations")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (convErr) logger.warn("Error reassigning conversations", { error: convErr.message });
    else tablesUpdated.conversations = convCount || 0;

    // messages
    const { count: msgCount, error: msgErr } = await supabase
      .from("messages")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (msgErr) logger.warn("Error reassigning messages", { error: msgErr.message });
    else tablesUpdated.messages = msgCount || 0;

    // sequence_enrollments
    const { count: seCount, error: seErr } = await supabase
      .from("sequence_enrollments")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (seErr) logger.warn("Error reassigning sequence_enrollments", { error: seErr.message });
    else tablesUpdated.sequence_enrollments = seCount || 0;

    // candidate_channels — handle unique conflicts by deleting duplicates first
    // First, find channels the survivor already has
    const { data: survivorChannels } = await supabase
      .from("candidate_channels")
      .select("channel_type")
      .eq("candidate_id", survivorId);
    const survivorChannelTypes = new Set((survivorChannels || []).map((c: any) => c.channel_type));

    // Delete merged candidate's channels that would conflict
    if (survivorChannelTypes.size > 0) {
      const { error: delChErr } = await supabase
        .from("candidate_channels")
        .delete()
        .eq("candidate_id", mergedId)
        .in("channel_type", Array.from(survivorChannelTypes));
      if (delChErr) logger.warn("Error deleting conflicting channels", { error: delChErr.message });
    }

    // Now reassign remaining channels
    const { count: chCount, error: chErr } = await supabase
      .from("candidate_channels")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (chErr) logger.warn("Error reassigning candidate_channels", { error: chErr.message });
    else tablesUpdated.candidate_channels = chCount || 0;

    // resumes
    const { count: resCount, error: resErr } = await supabase
      .from("resumes")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (resErr) logger.warn("Error reassigning resumes", { error: resErr.message });
    else tablesUpdated.resumes = resCount || 0;

    // resume_chunks
    const { count: chunkCount, error: chunkErr } = await supabase
      .from("resume_chunks")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (chunkErr) logger.warn("Error reassigning resume_chunks", { error: chunkErr.message });
    else tablesUpdated.resume_chunks = chunkCount || 0;

    // notes (entity_type='candidate')
    const { count: noteCount, error: noteErr } = await supabase
      .from("notes")
      .update({ entity_id: survivorId })
      .eq("entity_id", mergedId)
      .eq("entity_type", "candidate");
    if (noteErr) logger.warn("Error reassigning notes", { error: noteErr.message });
    else tablesUpdated.notes = noteCount || 0;

    // call_logs (linked_entity_type='candidate')
    const { count: callCount, error: callErr } = await supabase
      .from("call_logs")
      .update({ linked_entity_id: survivorId })
      .eq("linked_entity_id", mergedId)
      .eq("linked_entity_type", "candidate");
    if (callErr) logger.warn("Error reassigning call_logs", { error: callErr.message });
    else tablesUpdated.call_logs = callCount || 0;

    // send_outs
    const { count: soCount, error: soErr } = await supabase
      .from("send_outs")
      .update({ candidate_id: survivorId })
      .eq("candidate_id", mergedId);
    if (soErr) logger.warn("Error reassigning send_outs", { error: soErr.message });
    else tablesUpdated.send_outs = soCount || 0;

    logger.info("Reassigned related records", { tablesUpdated });

    // ── 5. Insert merge log ──────────────────────────────────────────
    const { error: logErr } = await supabase.from("candidate_merge_log").insert({
      survivor_id: survivorId,
      merged_id: mergedId,
      merged_data: merged,
      tables_updated: tablesUpdated,
      merged_by: mergedBy || null,
    });
    if (logErr) {
      logger.error("Failed to insert merge log", { error: logErr.message });
      // Don't throw — the merge is mostly done
    }

    // ── 6. Update duplicate_candidates entries ───────────────────────
    // Update any entries involving the merged candidate
    const { error: dupUpdErr1 } = await supabase
      .from("duplicate_candidates")
      .update({
        status: "merged",
        survivor_id: survivorId,
        merged_at: new Date().toISOString(),
        merged_by: mergedBy || null,
      })
      .eq("candidate_id_a", mergedId);

    if (dupUpdErr1) logger.warn("Error updating duplicate_candidates (a)", { error: dupUpdErr1.message });

    const { error: dupUpdErr2 } = await supabase
      .from("duplicate_candidates")
      .update({
        status: "merged",
        survivor_id: survivorId,
        merged_at: new Date().toISOString(),
        merged_by: mergedBy || null,
      })
      .eq("candidate_id_b", mergedId);

    if (dupUpdErr2) logger.warn("Error updating duplicate_candidates (b)", { error: dupUpdErr2.message });

    // ── 7. Delete the merged candidate ───────────────────────────────
    const { error: deleteErr } = await supabase
      .from("candidates")
      .delete()
      .eq("id", mergedId);

    if (deleteErr) {
      logger.error("Failed to delete merged candidate", { mergedId, error: deleteErr.message });
      throw new Error(`Failed to delete merged candidate: ${deleteErr.message}`);
    }

    logger.info("Candidate merge complete", { survivorId, mergedId, tablesUpdated });

    return {
      survivorId,
      mergedId,
      fieldsUpdated: Object.keys(updates),
      tablesUpdated,
    };
  },
});
