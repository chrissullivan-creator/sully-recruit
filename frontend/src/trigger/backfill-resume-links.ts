import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

const MATCH_PROMPT = `You are a resume parser. Extract ONLY the person's full name and most recent company from this resume. Return ONLY valid JSON, no markdown:
{"first_name": "First", "last_name": "Last", "current_company": "Company Name"}
If a field is not found, use an empty string.`;

const BATCH_SIZE = 25; // smaller batches to avoid rate limits

interface BackfillPayload {
  offset?: number;
  limit?: number;
}

// ── Claude API call with retry on 429 ───────────────────────────────────────
async function callClaude(
  contentBlocks: any[],
  anthropicKey: string,
  maxRetries = 3,
): Promise<any | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        system: MATCH_PROMPT,
        messages: [{ role: "user", content: contentBlocks }],
        temperature: 0,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data.content?.[0]?.text || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    }

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "30", 10);
      const waitMs = Math.max(retryAfter, 10) * 1000;
      logger.warn(`Rate limited (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Non-retryable error
    logger.warn("Claude API error", { status: resp.status });
    return null;
  }

  logger.warn("Claude API: max retries exhausted");
  return null;
}

// ── Match parsed name+company to a candidate and link resume ────────────────
async function matchAndLink(
  supabase: any,
  fullName: string,
  company: string,
  filePath: string,
  fileName: string,
): Promise<boolean> {
  const mimeType = fileName.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : fileName.toLowerCase().endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/octet-stream";

  // Try name + company first for tighter match
  if (company) {
    const { data: exactMatch } = await supabase
      .from("candidates")
      .select("id, full_name, current_company")
      .ilike("full_name", fullName)
      .ilike("current_company", `%${company}%`)
      .limit(1)
      .maybeSingle();

    if (exactMatch) {
      await supabase.from("resumes").insert({
        candidate_id: exactMatch.id,
        file_path: filePath,
        file_name: fileName,
        mime_type: mimeType,
        parsing_status: "completed",
      } as any);
      logger.info("Linked (name+company)", { candidateId: exactMatch.id, fullName, company });
      return true;
    }
  }

  // Fallback: match by name only
  const { data: nameMatch } = await supabase
    .from("candidates")
    .select("id, full_name")
    .ilike("full_name", fullName)
    .limit(1)
    .maybeSingle();

  if (nameMatch) {
    await supabase.from("resumes").insert({
      candidate_id: nameMatch.id,
      file_path: filePath,
      file_name: fileName,
      mime_type: mimeType,
      parsing_status: "completed",
    } as any);
    logger.info("Linked (name only)", { candidateId: nameMatch.id, fullName });
    return true;
  }

  logger.info("No candidate match", { fullName, company });
  return false;
}

// ── Main task ───────────────────────────────────────────────────────────────
export const backfillResumeLinks = task({
  id: "backfill-resume-links",
  retry: { maxAttempts: 1 },
  run: async (payload: BackfillPayload) => {
    const offset = payload.offset ?? 0;
    const limit = payload.limit ?? BATCH_SIZE;
    const supabase = getSupabaseAdmin();
    const anthropicKey = await getAnthropicKey();

    // Find unlinked storage files via DB function — always offset 0
    // since linked/marked files drop out of results each batch
    const { data: files, error: filesErr } = await supabase.rpc("get_unlinked_resume_files", {
      p_offset: 0,
      p_limit: limit,
    });

    if (filesErr || !files?.length) {
      logger.info("No more unlinked files to process", { error: filesErr?.message });
      return { processed: 0, linked: 0, done: true };
    }

    let linked = 0;
    let processed = 0;

    for (const file of files) {
      processed++;
      const filePath = file.file_path;
      const fileName = file.file_name || filePath.split("/").pop() || "unknown";

      try {
        // Download file
        const { data: downloadData, error: dlErr } = await supabase.storage
          .from("resumes")
          .download(filePath);

        if (dlErr || !downloadData) {
          logger.warn("Failed to download", { filePath, error: dlErr?.message });
          // Mark as processed so it doesn't reappear
          await supabase.from("resumes").insert({
            candidate_id: null, file_path: filePath, file_name: fileName,
            parsing_status: "failed",
          } as any);
          continue;
        }

        const fileBytes = new Uint8Array(await downloadData.arrayBuffer());
        if (fileBytes.length < 100) {
          logger.warn("File too small, skipping", { filePath, size: fileBytes.length });
          continue;
        }

        // Build content blocks for Claude
        const lowerName = fileName.toLowerCase();
        const contentBlocks: any[] = [];

        if (lowerName.endsWith(".pdf")) {
          const base64Data = Buffer.from(fileBytes).toString("base64");
          contentBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64Data },
          });
          contentBlocks.push({ type: "text", text: "Extract the person's name and current company." });
        } else {
          const text = new TextDecoder().decode(fileBytes);
          contentBlocks.push({
            type: "text",
            text: `Extract the person's name and current company from this resume:\n\n${text.slice(0, 4000)}`,
          });
        }

        // Call Claude with retry
        const parsed = await callClaude(contentBlocks, anthropicKey);
        if (!parsed) {
          await supabase.from("resumes").insert({
            candidate_id: null, file_path: filePath, file_name: fileName,
            parsing_status: "parse_failed",
          } as any);
          continue;
        }

        const firstName = (parsed.first_name || "").trim();
        const lastName = (parsed.last_name || "").trim();
        const company = (parsed.current_company || "").trim();

        if (!firstName && !lastName) {
          logger.warn("No name extracted", { filePath });
          // Mark as processed with no candidate
          await supabase.from("resumes").insert({
            candidate_id: null, file_path: filePath, file_name: fileName,
            parsing_status: "no_match",
          } as any);
          continue;
        }

        const fullName = `${firstName} ${lastName}`.trim();
        const wasLinked = await matchAndLink(supabase, fullName, company, filePath, fileName);
        if (wasLinked) {
          linked++;
        } else {
          // No candidate match — mark so it doesn't reappear
          await supabase.from("resumes").insert({
            candidate_id: null, file_path: filePath, file_name: fileName,
            parsing_status: "no_match",
          } as any);
        }

        // Rate limit: 2s between API calls to stay well under limits
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err: any) {
        logger.error("Error processing file", { filePath, error: err.message });
      }
    }

    // Auto-chain to next batch — always offset 0 since processed files
    // are now marked and won't appear again
    if (processed >= limit) {
      logger.info("Triggering next batch", { linked, processed });
      await backfillResumeLinks.trigger({ limit });
    }

    return { processed, linked, done: processed < limit };
  },
});
