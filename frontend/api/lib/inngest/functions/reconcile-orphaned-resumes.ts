import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAppSetting,
  getAnthropicKey,
  getGeminiKey,
  getOpenAIKey,
  getOpenRouterKey,
  getMistralKey,
} from "../../../../src/server-lib/supabase.js";
import { sendInternalEmail } from "../../../../src/server-lib/microsoft-graph.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";
import {
  matchPersonByEmail,
  classifyEmail,
} from "../../../../src/server-lib/match-person-by-email.js";
import {
  looksLikeResume,
  getVoyageEmbedding,
  buildProfileText,
  normalizeEmail,
  normalizeLinkedIn,
  delay,
} from "../../../../src/server-lib/resume-parsing.js";
import { parseResume } from "../../../../src/lib/resume-parser.js";
import { callAIWithFallback, RESUME_PARSE_ORDER } from "../../../../src/lib/ai-fallback.js";

type Verdict = "matched" | "created" | "failed" | "skipped";
interface ResumeOutcome {
  fileName: string;
  candidateName: string | null;
  verdict: Verdict;
  detail?: string;
}

async function maybeSendReport(outcomes: ResumeOutcome[], logger: any) {
  if (outcomes.length === 0) return;
  let sender = "";
  let recipients: string[] = [];
  try { sender = (await getAppSetting("RESUME_REPORT_SENDER")) || ""; } catch { /* not configured */ }
  try {
    const raw = (await getAppSetting("RESUME_REPORT_RECIPIENTS")) || "";
    recipients = raw.split(",").map((s) => s.trim()).filter(Boolean);
  } catch { /* not configured */ }
  if (!sender || recipients.length === 0) {
    logger.info("Resume report email skipped — sender/recipients not configured", {
      have_sender: !!sender,
      recipient_count: recipients.length,
    });
    return;
  }

  const counts = outcomes.reduce(
    (acc, o) => { acc[o.verdict] = (acc[o.verdict] ?? 0) + 1; return acc; },
    {} as Record<Verdict, number>,
  );

  const rowFor = (o: ResumeOutcome) => {
    const colors: Record<Verdict, string> = {
      created: "#16a34a", matched: "#0ea5e9", failed: "#dc2626", skipped: "#6b7280",
    };
    const labels: Record<Verdict, string> = {
      created: "Created", matched: "Matched", failed: "Failed", skipped: "Skipped",
    };
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${o.candidateName ? escapeHtml(o.candidateName) : "<em style='color:#999'>(no name)</em>"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666;font-family:monospace;font-size:12px">${escapeHtml(o.fileName)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${colors[o.verdict]};font-weight:600">${labels[o.verdict]}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#999;font-size:12px">${o.detail ? escapeHtml(o.detail) : ""}</td>
    </tr>`;
  };

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px">
      <h2 style="margin:0 0 4px 0">Resume parsing summary</h2>
      <p style="color:#666;margin:0 0 16px 0">
        ${outcomes.length} resume${outcomes.length === 1 ? "" : "s"} processed —
        <span style="color:#16a34a">${counts.created ?? 0} created</span>,
        <span style="color:#0ea5e9">${counts.matched ?? 0} matched</span>,
        <span style="color:#dc2626">${counts.failed ?? 0} failed</span>,
        <span style="color:#6b7280">${counts.skipped ?? 0} skipped</span>
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="text-align:left;background:#f9fafb">
          <th style="padding:8px 10px;border-bottom:2px solid #e5e7eb">Name</th>
          <th style="padding:8px 10px;border-bottom:2px solid #e5e7eb">File</th>
          <th style="padding:8px 10px;border-bottom:2px solid #e5e7eb">Verdict</th>
          <th style="padding:8px 10px;border-bottom:2px solid #e5e7eb">Detail</th>
        </tr></thead>
        <tbody>${outcomes.map(rowFor).join("")}</tbody>
      </table>
    </div>`;

  const subject = `Resume parsing — ${counts.created ?? 0} new, ${counts.matched ?? 0} matched, ${counts.failed ?? 0} failed`;
  try {
    await sendInternalEmail(sender, recipients, subject, html);
    logger.info("Resume report email sent", { sender, recipients, count: outcomes.length });
  } catch (e: any) {
    logger.warn("Resume report email failed", { error: e.message });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Best-effort name derivation from an upload filename, used when
 * extractResumeText returns no readable text (image-only PDF, exotic
 * DOCX, etc) so the resume still gets attached to *some* candidate row
 * rather than rotting in 'failed' purgatory. The bulk-uploader prefixes
 * files with `<timestamp>_<4char>_` — strip that and common
 * resume-noise tokens, then split on the remaining separators.
 */
function deriveNameFromFileName(fileName: string): { first_name: string | null; last_name: string | null } {
  const stem = (fileName || "")
    .replace(/^[0-9]{8,}_[A-Za-z0-9]{2,8}_/, "") // uploader prefix
    .replace(/\.[A-Za-z0-9]+$/, "")               // extension
    .replace(/__+\d+_+$/, "")                      // trailing `__2_` etc
    .replace(/\(\d+\)$/, "")
    .replace(/\b(resume|cv|curriculum[_\s-]?vitae|new|updated|final|v?\d+(?:\.\d+)*|march|april|may|june|july|august|september|october|november|december|january|february|20\d{2})\b/gi, " ")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stem) return { first_name: null, last_name: null };
  const tokens = stem.split(" ").filter((t) => /^[A-Za-z][A-Za-z.'-]*$/.test(t));
  if (tokens.length === 0) return { first_name: null, last_name: null };
  if (tokens.length === 1) return { first_name: tokens[0], last_name: null };
  return { first_name: tokens[0], last_name: tokens[tokens.length - 1] };
}

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
    // The unified `people` table has a UNIQUE constraint on
    // normalized_email — so any match (candidate or client) means we
    // must link to that row rather than insert. The caller below adds
    // the `candidate` role to client rows so they show up correctly.
    const m = await matchPersonByEmail(supabase, email);
    if (m) return m.entityId;
  }
  if (li) {
    const { data } = await supabase.from("people").select("id").ilike("linkedin_url", `%${li}%`).maybeSingle();
    if (data) return data.id;
  }
  if (parsed.first_name && parsed.last_name && parsed.current_company) {
    const { data } = await supabase
      .from("people")
      .select("id")
      .ilike("first_name", parsed.first_name)
      .ilike("last_name", parsed.last_name)
      .ilike("current_company", `%${parsed.current_company}%`)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

/**
 * Find orphaned resumes (no candidate_id), parse them via the Mistral
 * OCR + Gemini→OpenAI cascade, match to existing people or create new
 * ones, embed with Voyage, and email a daily summary.
 *
 * Every minute. Ported from `src/trigger/reconcile-orphaned-resumes.ts`
 * — Inngest is the only scheduler now.
 */
export const reconcileOrphanedResumes = inngest.createFunction(
  { id: "reconcile-orphaned-resumes", name: "Reconcile orphaned resumes (Inngest)" },
  { cron: "* * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const limit = 4;

    const { data: withData } = await supabase
      .from("resumes")
      .select("id, file_path, file_name, raw_text, parsed_json, parsing_status")
      .is("candidate_id", null)
      .not("parsing_status", "in", '("failed","skipped")')
      .or("raw_text.not.is.null,parsed_json.not.is.null")
      .limit(5);

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

    let matched = 0,
      created = 0,
      failed = 0,
      embedded = 0,
      blacklistedSkipped = 0;
    const errors: string[] = [];
    const outcomes: ResumeOutcome[] = [];

    const [anthropicKey, openaiKey, geminiKey, openRouterKey, mistralKey] = await Promise.all([
      getAnthropicKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
      getGeminiKey().catch(() => ""),
      getOpenRouterKey().catch(() => ""),
      getMistralKey().catch(() => ""),
    ]);
    if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
      logger.warn("Reconcile: no ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY — cannot parse");
      return { skipped: true, reason: "no_ai_keys" };
    }
    const parseOpts = {
      mistralKey: mistralKey || undefined,
      callAI: (req: any) =>
        callAIWithFallback({
          ...req,
          anthropicKey: anthropicKey || undefined,
          openaiKey: openaiKey || undefined,
          geminiKey: geminiKey || undefined,
          openRouterKey: openRouterKey || undefined,
          order: RESUME_PARSE_ORDER,
        }),
      log: logger,
    };

    for (const resume of allToProcess) {
      try {
        let parsed: any;
        let rawText: string | null = null;

        // Falls back to a filename-derived stub when extractResumeText
        // yields no readable text, so the candidate + resume still land
        // in the system rather than dying in 'failed'.
        const runParse = async (): Promise<{ parsed: any; rawText: string | null }> => {
          const { data: urlData } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
          const buf = await fetch(urlData.publicUrl, { signal: AbortSignal.timeout(20_000) }).then((r: any) =>
            r.arrayBuffer(),
          );
          try {
            const r2 = await parseResume(buf, resume.fileName, parseOpts);
            return { parsed: r2.parsed, rawText: r2.rawText };
          } catch (err: any) {
            const msg = String(err?.message || "");
            if (!/empty or unreadable/i.test(msg)) throw err;
            const derived = deriveNameFromFileName(resume.fileName);
            if (!derived.first_name) throw err;
            logger.warn("parseResume empty — falling back to filename-derived stub", {
              fileName: resume.fileName,
              derived,
            });
            return { parsed: derived, rawText: null };
          }
        };

        if (resume.hasData) {
          parsed = resume.parsed_json ?? {};
          rawText = resume.raw_text ?? null;
          if (!parsed.first_name && rawText) {
            const result = await runParse();
            parsed = result.parsed;
            rawText = result.rawText;
          }
        } else {
          const result = await runParse();
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
          outcomes.push({
            fileName: resume.fileName,
            candidateName: null,
            verdict: "skipped",
            detail: "no name or email",
          });
          continue;
        }

        const blacklisted = await isBlacklisted(supabase, parsed, resume.fileName);
        if (blacklisted) {
          logger.info(`Blacklisted: ${fullName || parsed.email} (${resume.fileName})`);
          await supabase.from("resumes").update({ parsing_status: "skipped" }).eq("id", resume.id);
          blacklistedSkipped++;
          outcomes.push({
            fileName: resume.fileName,
            candidateName: fullName || parsed.email || null,
            verdict: "skipped",
            detail: "previously deleted",
          });
          continue;
        }

        let candidateId = await findExistingCandidate(supabase, parsed);
        const wasMatch = !!candidateId;

        if (candidateId) {
          const { data: existing } = await supabase
            .from("people")
            .select("current_title, current_company, location_text, skills, resume_url, roles")
            .eq("id", candidateId)
            .maybeSingle();

          if (existing) {
            const updates: Record<string, any> = { updated_at: new Date().toISOString() };
            if (!existing.current_title && parsed.current_title)
              updates.current_title = parsed.current_title;
            if (!existing.current_company && parsed.current_company)
              updates.current_company = parsed.current_company;
            if (!existing.location_text && parsed.location)
              updates.location_text = parsed.location;
            if ((!existing.skills || !existing.skills.length) && skills.length)
              updates.skills = skills;
            if (!existing.resume_url) {
              const { data: pub } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
              updates.resume_url = pub.publicUrl;
            }
            const currentRoles: string[] = Array.isArray(existing.roles) ? existing.roles : [];
            if (!currentRoles.includes("candidate")) {
              updates.roles = [...currentRoles, "candidate"];
            }
            if (Object.keys(updates).length > 1) {
              await supabase.from("people").update(updates).eq("id", candidateId);
            }
          }
          matched++;
        } else {
          const { data: pub } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
          const { data: newCand, error: insertErr } = await supabase
            .from("people")
            .insert({
              first_name: parsed.first_name || null,
              last_name: parsed.last_name || null,
              full_name: fullName || null,
              ...classifyEmail(parsed.email || null),
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

        try {
          const profileText = buildProfileText(
            {
              full_name: fullName,
              current_title: parsed.current_title,
              current_company: parsed.current_company,
              location_text: parsed.location,
              skills,
            },
            normalizedRawText,
            parsed,
          );
          if (profileText.trim().length >= 50) {
            const embedding = await getVoyageEmbedding(profileText);
            await supabase
              .from("resume_embeddings")
              .delete()
              .eq("candidate_id", candidateId)
              .eq("embed_type", "full_profile");
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

        logger.info(`${resume.fileName} → ${wasMatch ? "matched" : "created"}`);
        outcomes.push({
          fileName: resume.fileName,
          candidateName: fullName || parsed.email || null,
          verdict: wasMatch ? "matched" : "created",
        });
      } catch (err: any) {
        failed++;
        const detail = (err?.message ?? "unknown").slice(0, 200);
        errors.push(`${resume.fileName}: ${detail}`);
        await supabase.from("resumes").update({ parsing_status: "failed", parse_error: detail }).eq("id", resume.id);
        outcomes.push({ fileName: resume.fileName, candidateName: null, verdict: "failed", detail });
        await notifyError({
          taskId: "reconcile-orphaned-resumes",
          error: err,
          context: { resumeId: resume.id, fileName: resume.fileName },
          severity: "WARN",
        });
      }

      await delay(300);
    }

    await maybeSendReport(outcomes, logger);

    const { count: remaining } = await supabase
      .from("resumes")
      .select("id", { count: "exact", head: true })
      .is("candidate_id", null)
      .not("parsing_status", "in", '("failed","skipped")');

    logger.info("Reconcile complete", {
      matched,
      created,
      embedded,
      failed,
      blacklistedSkipped,
      remaining: remaining ?? 0,
    });
    return {
      processed: allToProcess.length,
      matched,
      created,
      embedded,
      failed,
      blacklistedSkipped,
      junkFlagged: junkIds.length,
      remaining: remaining ?? 0,
    };
  },
);
