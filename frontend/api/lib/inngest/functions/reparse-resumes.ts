import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getGeminiKey,
  getOpenAIKey,
  getOpenRouterKey,
  getMistralKey,
} from "../../../../src/trigger/lib/supabase.js";
import {
  looksLikeResume,
  getVoyageEmbedding,
  buildProfileText,
  delay,
} from "../../../../src/trigger/lib/resume-parsing.js";
import { parseResume } from "../../../../src/lib/resume-parser.js";
import { callAIWithFallback } from "../../../../src/lib/ai-fallback.js";

/**
 * Re-parse resumes that have a candidate_id but no raw_text. Downloads
 * from Supabase storage, parses via the Mistral OCR + Gemini→OpenAI
 * cascade, backfills missing candidate fields, and embeds the result
 * with Voyage.
 *
 * Every minute. Ported from `src/trigger/reparse-resumes.ts` —
 * Inngest is the only scheduler now.
 */
export const reparseResumes = inngest.createFunction(
  { id: "reparse-resumes", name: "Reparse resumes missing raw_text (Inngest)" },
  { cron: "* * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const limit = 10;

    const { data: unparsedRaw, error } = await supabase
      .from("resumes")
      .select("id, candidate_id, file_path, file_name, parsing_status")
      .not("candidate_id", "is", null)
      .or("raw_text.is.null,raw_text.eq.")
      .not("parsing_status", "in", '("failed","skipped","completed","parsed")')
      .order("created_at", { ascending: false })
      .limit(limit * 4);

    if (error) throw new Error(`Query error: ${error.message}`);

    const seen = new Set<string>();
    const filtered: any[] = [];
    const junkIds: string[] = [];

    for (const r of unparsedRaw ?? []) {
      const fileName = r.file_name || r.file_path.split("/").pop() || "";
      if (!looksLikeResume(fileName)) { junkIds.push(r.id); continue; }
      const key = `${r.candidate_id}::${fileName.toLowerCase().trim()}`;
      if (seen.has(key)) { junkIds.push(r.id); continue; }
      seen.add(key);
      filtered.push({ ...r, fileName });
      if (filtered.length >= limit) break;
    }

    if (junkIds.length > 0) {
      await supabase.from("resumes").update({ parsing_status: "skipped" }).in("id", junkIds);
    }

    const { count: remaining } = await supabase
      .from("resumes")
      .select("id", { count: "exact", head: true })
      .not("candidate_id", "is", null)
      .or("raw_text.is.null,raw_text.eq.")
      .not("parsing_status", "in", '("failed","skipped","completed","parsed")');

    if (filtered.length === 0) {
      logger.info("No parseable resumes found", {
        remaining: remaining ?? 0,
        junkSkipped: junkIds.length,
      });
      return { parsed: 0, remaining: remaining ?? 0, skippedJunk: junkIds.length };
    }

    let parsedCount = 0,
      embeddedCount = 0,
      failedCount = 0;
    const errors: string[] = [];

    const [geminiKey, openaiKey, openRouterKey, mistralKey] = await Promise.all([
      getGeminiKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
      getOpenRouterKey().catch(() => ""),
      getMistralKey().catch(() => ""),
    ]);
    if (!geminiKey && !openaiKey && !openRouterKey) {
      logger.warn("Reparse: no GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY — cannot run");
      return { skipped: true, reason: "no_ai_keys" };
    }

    for (let i = 0; i < filtered.length; i++) {
      const resume = filtered[i];
      try {
        const { data: urlData } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
        const publicUrl = urlData?.publicUrl;
        if (!publicUrl) throw new Error("No public URL");

        const buf = await fetch(publicUrl, { signal: AbortSignal.timeout(20_000) }).then((r: any) =>
          r.arrayBuffer(),
        );
        const { parsed, rawText } = await parseResume(buf, resume.fileName, {
          mistralKey: mistralKey || undefined,
          callAI: (req) =>
            callAIWithFallback({
              ...req,
              geminiKey: geminiKey || undefined,
              openaiKey: openaiKey || undefined,
              openRouterKey: openRouterKey || undefined,
            }),
          log: logger,
        });
        const normalizedRawText = (rawText ?? JSON.stringify(parsed)).slice(0, 50000);
        const skills = Array.isArray(parsed?.skills)
          ? parsed.skills.map((s: any) => String(s)).filter(Boolean).slice(0, 25)
          : [];

        await supabase
          .from("resumes")
          .update({
            raw_text: normalizedRawText,
            parsed_json: parsed,
            parsing_status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", resume.id);
        parsedCount++;

        const { data: candidate } = await supabase
          .from("people")
          .select("id, full_name, current_title, current_company, location_text, skills")
          .eq("id", resume.candidate_id)
          .single();

        if (candidate) {
          const updates: Record<string, any> = { updated_at: new Date().toISOString() };
          if (!candidate.current_title && parsed.current_title)
            updates.current_title = parsed.current_title;
          if (!candidate.current_company && parsed.current_company)
            updates.current_company = parsed.current_company;
          if (!candidate.location_text && parsed.location)
            updates.location_text = parsed.location;
          if ((!candidate.skills || !candidate.skills.length) && skills.length)
            updates.skills = skills;
          if (!candidate.full_name && parsed.first_name) {
            updates.first_name = parsed.first_name;
            updates.last_name = parsed.last_name || "";
            updates.full_name = [parsed.first_name, parsed.last_name].filter(Boolean).join(" ");
          }
          if (Object.keys(updates).length > 1) {
            await supabase.from("people").update(updates).eq("id", resume.candidate_id);
          }

          try {
            const profileText = buildProfileText(candidate, normalizedRawText, parsed);
            if (profileText.trim().length >= 50) {
              const embedding = await getVoyageEmbedding(profileText);
              await supabase
                .from("resume_embeddings")
                .delete()
                .eq("candidate_id", resume.candidate_id)
                .eq("embed_type", "full_profile");
              await supabase.from("resume_embeddings").insert({
                candidate_id: resume.candidate_id,
                resume_id: resume.id,
                embedding: JSON.stringify(embedding),
                source_text: profileText.slice(0, 2000),
                chunk_text: profileText.slice(0, 2000),
                chunk_index: 0,
                embed_type: "full_profile",
                embed_model: "voyage-finance-2",
              });
              embeddedCount++;
            }
          } catch (e: any) {
            logger.warn("Embedding failed", { error: e.message });
          }
        }
      } catch (err: any) {
        failedCount++;
        errors.push(`${resume.fileName}: ${err?.message ?? "unknown"}`);
        await supabase.from("resumes").update({ parsing_status: "failed" }).eq("id", resume.id);
      }

      if (i < filtered.length - 1) await delay(1500);
    }

    logger.info("Reparse complete", {
      parsed: parsedCount,
      embedded: embeddedCount,
      failed: failedCount,
    });
    return {
      total: filtered.length,
      parsed: parsedCount,
      embedded: embeddedCount,
      failed: failedCount,
      skippedJunk: junkIds.length,
      remaining: Math.max(0, (remaining ?? 0) - parsedCount),
    };
  },
);
