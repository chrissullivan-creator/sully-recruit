import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAnthropicKey } from "./lib/supabase";

const MATCH_PROMPT = `You are a resume parser. Extract ONLY the person's full name and most recent company from this resume. Return ONLY valid JSON, no markdown:
{"first_name": "First", "last_name": "Last", "current_company": "Company Name"}
If a field is not found, use an empty string.`;

const BATCH_SIZE = 50;

interface BackfillPayload {
  offset?: number;
  limit?: number;
}

export const backfillResumeLinks = task({
  id: "backfill-resume-links",
  retry: { maxAttempts: 1 },
  run: async (payload: BackfillPayload) => {
    const offset = payload.offset ?? 0;
    const limit = payload.limit ?? BATCH_SIZE;
    const supabase = getSupabaseAdmin();
    const anthropicKey = await getAnthropicKey();

    // Find unlinked storage files
    const { data: files, error: filesErr } = await supabase.rpc("get_unlinked_resume_files", {
      p_offset: offset,
      p_limit: limit,
    });

    // Fallback: query storage.objects directly
    let unlinkedFiles: { file_path: string; file_name: string; mime_type: string }[] = [];

    if (filesErr || !files?.length) {
      // Use raw SQL approach via a simpler query
      const { data: storageFiles } = await supabase
        .from("storage_objects_unlinked_resumes" as any)
        .select("*")
        .range(offset, offset + limit - 1);

      if (!storageFiles?.length) {
        logger.info("No more unlinked files to process", { offset });
        return { processed: 0, linked: 0, done: true };
      }
      unlinkedFiles = storageFiles;
    } else {
      unlinkedFiles = files;
    }

    let linked = 0;
    let processed = 0;

    for (const file of unlinkedFiles) {
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
          continue;
        }

        const fileBytes = new Uint8Array(await downloadData.arrayBuffer());
        if (fileBytes.length < 100) {
          logger.warn("File too small, skipping", { filePath, size: fileBytes.length });
          continue;
        }

        // Parse with Claude Haiku — just extract name + company
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
          // For doc/docx/txt, try to get raw text
          const text = new TextDecoder().decode(fileBytes);
          const snippet = text.slice(0, 4000);
          contentBlocks.push({
            type: "text",
            text: `Extract the person's name and current company from this resume:\n\n${snippet}`,
          });
        }

        const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
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

        if (!aiResp.ok) {
          logger.warn("Claude API error", { status: aiResp.status, filePath });
          continue;
        }

        const aiData = await aiResp.json();
        const text = aiData.content?.[0]?.text || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.warn("No JSON in Claude response", { filePath, text: text.slice(0, 200) });
          continue;
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const firstName = (parsed.first_name || "").trim();
        const lastName = (parsed.last_name || "").trim();
        const company = (parsed.current_company || "").trim();

        if (!firstName && !lastName) {
          logger.warn("No name extracted", { filePath });
          continue;
        }

        // Match against candidates by name + company
        const fullName = `${firstName} ${lastName}`.trim();
        let query = supabase
          .from("candidates")
          .select("id, full_name, current_company")
          .ilike("full_name", fullName);

        if (company) {
          // Try name + company first for tighter match
          const { data: exactMatch } = await supabase
            .from("candidates")
            .select("id, full_name, current_company")
            .ilike("full_name", fullName)
            .ilike("current_company", `%${company}%`)
            .limit(1)
            .maybeSingle();

          if (exactMatch) {
            // Link it
            await supabase.from("resumes").insert({
              candidate_id: exactMatch.id,
              file_path: filePath,
              file_name: fileName,
              mime_type: lowerName.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
              parsing_status: "completed",
            } as any);
            linked++;
            logger.info("Linked resume (name+company)", {
              filePath,
              candidateId: exactMatch.id,
              fullName,
              company,
            });
            continue;
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
            mime_type: lowerName.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
            parsing_status: "completed",
          } as any);
          linked++;
          logger.info("Linked resume (name only)", {
            filePath,
            candidateId: nameMatch.id,
            fullName,
          });
        } else {
          logger.info("No candidate match found", { filePath, fullName, company });
        }

        // Rate limit: small delay between API calls
        await new Promise((r) => setTimeout(r, 500));
      } catch (err: any) {
        logger.error("Error processing file", { filePath, error: err.message });
      }
    }

    // Auto-chain to next batch if there are more files
    if (processed >= limit) {
      logger.info("Triggering next batch", { nextOffset: offset + limit });
      await backfillResumeLinks.trigger({ offset: offset + limit, limit });
    }

    return { processed, linked, offset, done: processed < limit };
  },
});
