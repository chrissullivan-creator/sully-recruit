import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import {
  looksLikeResume,
  parseWithClaude,
  getVoyageEmbedding,
  buildProfileText,
  normalizeEmail,
  normalizeLinkedIn,
  delay,
} from "./lib/resume-parsing";

/**
 * Find orphaned resumes (no candidate_id), parse them with Claude,
 * match to existing candidates or create new ones, embed with Voyage.
 *
 * Schedule in Trigger.dev Dashboard:
 *   Task: reconcile-orphaned-resumes
 *   Cron: * * * * * (every minute)
 */

async function isBlacklisted(supabase: any, parsed: any, fileName: string): Promise<boolean> {
  const email = normalizeEmail(parsed.email);
  const fullName = [parsed.first_name, parsed.last_name].filter(Boolean).join(" ").toLowerCase();
  const fileNameLower = fileName.toLowerCase();

  const conditions = [
    email ? `email.eq.${email}` : null,
    fullName ? `full_name.ilike.${fullName}` : null,
    `file_name.ilike.${fileNameLower}`,
  ].filter(Boolean);

  const { data } = await supabase
    .from("deleted_candidate_blacklist")
    .select("id")
    .or(conditions.join(","))
    .limit(1)
    .maybeSingle();

  return !!data;
}

async function findExistingCandidate(supabase: any, parsed: any): Promise<string | null> {
  const email = normalizeEmail(parsed.email);
  const li = normalizeLinkedIn(parsed.linkedin_url);

  if (email) {
    const { data } = await supabase.from("candidates").select("id").ilike("email", email).maybeSingle();
    if (data) return data.id;
  }
  if (li) {
    const { data } = await supabase.from("candidates").select("id").ilike("linkedin_url", `%${li}%`).maybeSingle();
    if (data) return data.id;
  }
  if (parsed.first_name && parsed.last_name && parsed.current_company) {
    const { data } = await supabase
      .from("candidates")
      .select("id")
      .ilike("first_name", parsed.first_name)
      .ilike("last_name", parsed.last_name)
      .ilike("current_company", `%${parsed.current_company}%`)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

export const reconcileOrphanedResumes = schedules.task({
  id: "reconcile-orphaned-resumes",
  maxDuration: 240,
  run: async () => {
    const supabase = getSupabaseAdmin();
    const limit = 10;

    // Resumes with existing parsed data but no candidate
    const { data: withData } = await supabase
      .from("resumes")
      .select("id, file_path, file_name, raw_text, parsed_json, parsing_status")
      .is("candidate_id", null)
      .not("parsing_status", "in", '("failed","skipped")')
      .or("raw_text.not.is.null,parsed_json.not.is.null")
      .limit(5);

    // Resumes needing parsing
    const { data: unparsed } = await supabase
      .from("resumes")
      .select("id, file_path, file_name, parsing_status")
      .is("candidate_id", null)
      .or("raw_text.is.null,raw_text.eq.")
      .not("parsing_status", "in", '("failed","skipped","completed","parsed")')
      .order("created_at", { ascending: false })
      .limit(limit * 3);

    const seen = new Set<string>();
    const toProcess: any[] = [];
    const junkIds: string[] = [];

    for (const r of unparsed ?? []) {
      const fileName = r.file_name || r.file_path.split("/").pop() || "";
      if (!looksLikeResume(fileName)) { junkIds.push(r.id); continue; }
      const key = fileName.toLowerCase().trim();
      if (seen.has(key)) { junkIds.push(r.id); continue; }
      seen.add(key);
      toProcess.push({ ...r, fileName });
      if (toProcess.length >= limit) break;
    }

    if (junkIds.length > 0) {
      await supabase.from("resumes").update({ parsing_status: "skipped" }).in("id", junkIds);
    }

    const allToProcess = [
      ...(withData ?? []).map((r: any) => ({
        ...r,
        fileName: r.file_name || r.file_path.split("/").pop() || "",
        hasData: true,
      })),
      ...toProcess.map((r: any) => ({ ...r, hasData: false })),
    ];

    if (allToProcess.length === 0) {
      const { count } = await supabase
        .from("resumes")
        .select("id", { count: "exact", head: true })
        .is("candidate_id", null)
        .not("parsing_status", "in", '("failed","skipped")');
      logger.info("No orphaned resumes to process", { remaining: count ?? 0 });
      return { processed: 0, remaining: count ?? 0, junkFlagged: junkIds.length };
    }

    let matched = 0, created = 0, failed = 0, embedded = 0, blacklistedSkipped = 0;
    const errors: string[] = [];

    for (const resume of allToProcess) {
      try {
        let parsed: any;
        let rawText: string | null = null;

        if (resume.hasData) {
          parsed = resume.parsed_json ?? {};
          rawText = resume.raw_text ?? null;
          if (!parsed.first_name && rawText) {
            const { data: urlData } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
            const buf = await fetch(urlData.publicUrl, { signal: AbortSignal.timeout(20_000) }).then((r: any) => r.arrayBuffer());
            const result = await parseWithClaude(buf, resume.fileName);
            parsed = result.parsed;
            rawText = result.rawText;
          }
        } else {
          const { data: urlData } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
          const buf = await fetch(urlData.publicUrl, { signal: AbortSignal.timeout(20_000) }).then((r: any) => r.arrayBuffer());
          const result = await parseWithClaude(buf, resume.fileName);
          parsed = result.parsed;
          rawText = result.rawText;
        }

        const skills = Array.isArray(parsed?.skills)
          ? parsed.skills.map((s: any) => String(s)).filter(Boolean).slice(0, 25)
          : [];
        const normalizedRawText = (rawText ?? JSON.stringify(parsed)).slice(0, 50000);
        const fullName = [parsed.first_name, parsed.last_name].filter(Boolean).join(" ");

        if (!fullName && !parsed.email) {
          await supabase.from("resumes").update({ parsing_status: "skipped" }).eq("id", resume.id);
          continue;
        }

        // Blacklist check
        const blacklisted = await isBlacklisted(supabase, parsed, resume.fileName);
        if (blacklisted) {
          logger.info(`Blacklisted: ${fullName || parsed.email} (${resume.fileName})`);
          await supabase.from("resumes").update({ parsing_status: "skipped" }).eq("id", resume.id);
          blacklistedSkipped++;
          continue;
        }

        let candidateId = await findExistingCandidate(supabase, parsed);

        if (candidateId) {
          // Update existing candidate with missing fields
          const { data: existing } = await supabase
            .from("candidates")
            .select("current_title, current_company, location_text, skills, resume_url")
            .eq("id", candidateId)
            .maybeSingle();

          if (existing) {
            const updates: Record<string, any> = { updated_at: new Date().toISOString() };
            if (!existing.current_title && parsed.current_title) updates.current_title = parsed.current_title;
            if (!existing.current_company && parsed.current_company) updates.current_company = parsed.current_company;
            if (!existing.location_text && parsed.location) updates.location_text = parsed.location;
            if ((!existing.skills || !existing.skills.length) && skills.length) updates.skills = skills;
            if (!existing.resume_url) {
              const { data: pub } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
              updates.resume_url = pub.publicUrl;
            }
            if (Object.keys(updates).length > 1) {
              await supabase.from("candidates").update(updates).eq("id", candidateId);
            }
          }
          matched++;
        } else {
          // Create new candidate
          const { data: pub } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
          const { data: newCand, error: insertErr } = await supabase
            .from("candidates")
            .insert({
              first_name: parsed.first_name || null,
              last_name: parsed.last_name || null,
              full_name: fullName || null,
              email: parsed.email || null,
              phone: parsed.phone || null,
              linkedin_url: parsed.linkedin_url || null,
              current_title: parsed.current_title || null,
              current_company: parsed.current_company || null,
              location_text: parsed.location || null,
              skills: skills.length ? skills : null,
              resume_url: pub.publicUrl,
              status: "new",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .select("id")
            .single();
          if (insertErr || !newCand) throw new Error(`Create candidate failed: ${insertErr?.message}`);
          candidateId = newCand.id;
          created++;
        }

        // Update resume record
        await supabase
          .from("resumes")
          .update({
            candidate_id: candidateId,
            raw_text: normalizedRawText,
            parsed_json: parsed,
            parsing_status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", resume.id);

        // Embed
        try {
          const profileText = buildProfileText(
            { full_name: fullName, current_title: parsed.current_title, current_company: parsed.current_company, location_text: parsed.location, skills },
            normalizedRawText,
            parsed,
          );
          if (profileText.trim().length >= 50) {
            const embedding = await getVoyageEmbedding(profileText);
            await supabase.from("resume_embeddings").delete().eq("candidate_id", candidateId).eq("embed_type", "full_profile");
            await supabase.from("resume_embeddings").insert({
              candidate_id: candidateId,
              resume_id: resume.id,
              embedding: JSON.stringify(embedding),
              source_text: profileText.slice(0, 2000),
              chunk_text: profileText.slice(0, 2000),
              chunk_index: 0,
              embed_type: "full_profile",
              embed_model: "voyage-finance-2",
            });
            embedded++;
          }
        } catch (e: any) {
          logger.warn("Embedding failed", { error: e.message });
        }

        logger.info(`${resume.fileName} → ${candidateId ? (matched > 0 ? "matched" : "created") : "processed"}`);
      } catch (err: any) {
        failed++;
        errors.push(`${resume.fileName}: ${err?.message ?? "unknown"}`);
        await supabase.from("resumes").update({ parsing_status: "failed" }).eq("id", resume.id);
      }

      await delay(1500);
    }

    const { count: remaining } = await supabase
      .from("resumes")
      .select("id", { count: "exact", head: true })
      .is("candidate_id", null)
      .not("parsing_status", "in", '("failed","skipped")');

    logger.info("Reconcile complete", { matched, created, embedded, failed, blacklistedSkipped, remaining: remaining ?? 0 });
    return { processed: allToProcess.length, matched, created, embedded, failed, blacklistedSkipped, junkFlagged: junkIds.length, remaining: remaining ?? 0 };
  },
});
