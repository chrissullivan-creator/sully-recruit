import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import mammoth from "npm:mammoth";
import { Buffer } from "node:buffer";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const VOYAGE_MODEL = "voyage-finance-2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const RESUME_SYSTEM = `You are a resume parser for The Emerald Recruiting Group, a Wall Street staffing firm. Extract structured candidate data from resumes with precision.

Return ONLY a raw JSON object — no markdown fences, no backticks, no preamble. Just the JSON:
{
  "first_name": "",
  "last_name": "",
  "email": "",
  "phone": "",
  "linkedin_url": "",
  "location": "",
  "current_title": "",
  "current_company": "",
  "skills": []
}

Rules:
- Use empty string for unknown fields, empty array for no skills
- Extract up to 25 most relevant skills
- current_title and current_company: most recent role only`;

const JUNK_PATTERNS = [
  /invoice/i, /receipt/i, /confirmation/i, /waiver/i,
  /order[_\s-]?id/i, /\bform\b/i, /\bsigned\b/i,
  /\bagreement\b/i, /\bcontract\b/i, /offer[_\s-]?letter/i,
  /cover[_\s-]?letter/i, /\breference/i, /\btranscript\b/i,
  /\bdegree\b/i, /\bcertif/i, /\blicense\b/i,
  /emerald.recruiting/i, /fiera/i, /\bpitch\b/i,
  /\bproposal\b/i, /\bpresentation\b/i, /\bmarketing\b/i,
  /^\d{8,}_\d+/, /^[a-f0-9-]{32,}\.pdf$/i,
];

function looksLikeResume(fileName: string): boolean {
  const lower = (fileName || "").toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".docx") && !lower.endsWith(".doc")) return false;
  for (const p of JUNK_PATTERNS) { if (p.test(fileName)) return false; }
  return true;
}

function getExtension(s: string): "pdf" | "docx" | "doc" {
  const l = (s || "").toLowerCase();
  if (l.endsWith(".pdf")) return "pdf";
  if (l.endsWith(".docx")) return "docx";
  return "doc";
}

async function fetchBuf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  return res.arrayBuffer();
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 8192)
    b64 += btoa(String.fromCharCode(...bytes.slice(i, i + 8192)));
  return b64;
}

function parseClaudeResponse(raw: string): any {
  const json = JSON.parse(raw);
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error("Claude missing content");
  return JSON.parse(text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim());
}

async function parseWithClaude(publicUrl: string, fileName: string): Promise<{ parsed: any; rawText: string | null }> {
  const ext = getExtension(fileName);
  if (ext === "pdf") {
    const buf = await fetchBuf(publicUrl);
    const header = new Uint8Array(buf.slice(0, 4));
    if (!(header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46))
      throw new Error(`Invalid PDF`);
    const b64 = toBase64(buf);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 1024, system: RESUME_SYSTEM,
        messages: [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
          { type: "text", text: "Parse this resume and return the JSON." },
        ]}],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { parsed: parseClaudeResponse(await res.text()), rawText: null };
  }
  const buffer = Buffer.from(await fetchBuf(publicUrl));
  const result = await mammoth.extractRawText({ buffer });
  const rawText = (result.value || "").trim();
  if (!rawText) throw new Error(`Empty text from ${fileName}`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 1024, system: RESUME_SYSTEM,
      messages: [{ role: "user", content: `Resume text:\n\n${rawText.slice(0, 30000)}\n\nParse and return JSON.` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { parsed: parseClaudeResponse(await res.text()), rawText };
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}
function normLinkedIn(u: string | null | undefined): string | null {
  const m = (u ?? "").match(/linkedin\.com\/in\/([^/?\s#]+)/);
  return m ? m[1].toLowerCase().replace(/\/+$/, "") : null;
}

// Check if a parsed candidate is on the deleted blacklist
async function isBlacklisted(supabase: any, parsed: any, fileName: string): Promise<boolean> {
  const email = norm(parsed.email);
  const fullName = [parsed.first_name, parsed.last_name].filter(Boolean).join(" ").toLowerCase();
  const fileNameLower = fileName.toLowerCase();

  const { data } = await supabase
    .from("deleted_candidate_blacklist")
    .select("id")
    .or([
      email ? `email.eq.${email}` : null,
      fullName ? `full_name.ilike.${fullName}` : null,
      `file_name.ilike.${fileNameLower}`,
    ].filter(Boolean).join(","))
    .limit(1)
    .maybeSingle();

  return !!data;
}

async function findExistingCandidate(supabase: any, parsed: any): Promise<string | null> {
  const email = norm(parsed.email);
  const li = normLinkedIn(parsed.linkedin_url);

  if (email) {
    const { data } = await supabase.from("candidates").select("id").ilike("email", email).maybeSingle();
    if (data) return data.id;
  }
  if (li) {
    const { data } = await supabase.from("candidates").select("id").ilike("linkedin_url", `%${li}%`).maybeSingle();
    if (data) return data.id;
  }
  if (parsed.first_name && parsed.last_name && parsed.current_company) {
    const { data } = await supabase.from("candidates").select("id")
      .ilike("first_name", parsed.first_name)
      .ilike("last_name", parsed.last_name)
      .ilike("current_company", `%${parsed.current_company}%`)
      .maybeSingle();
    if (data) return data.id;
  }
  return null;
}

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}`);
  return (await res.json()).data[0].embedding;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  try {
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

    const body = await req.json().catch(() => ({}));
    const limit = Math.min(body.limit ?? 10, 15);
    const dry_run = body.dry_run ?? false;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
      ...(withData ?? []).map(r => ({ ...r, fileName: r.file_name || r.file_path.split("/").pop() || "", hasData: true })),
      ...toProcess.map(r => ({ ...r, hasData: false })),
    ];

    if (allToProcess.length === 0) {
      const { count } = await supabase.from("resumes")
        .select("id", { count: "exact", head: true })
        .is("candidate_id", null)
        .not("parsing_status", "in", '("failed","skipped")');
      return respond({ message: "No orphaned resumes to process 🎉", remaining: count ?? 0, junk_flagged: junkIds.length });
    }

    if (dry_run) {
      const { count } = await supabase.from("resumes")
        .select("id", { count: "exact", head: true })
        .is("candidate_id", null)
        .not("parsing_status", "in", '("failed","skipped")');
      return respond({ dry_run: true, total_orphaned: count ?? 0, to_process: allToProcess.length, junk_flagged: junkIds.length, sample: allToProcess.slice(0, 8).map(r => r.fileName) });
    }

    let matched = 0, created = 0, failed = 0, embedded = 0, blacklisted_skipped = 0;
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
            const { parsed: p, rawText: rt } = await parseWithClaude(urlData.publicUrl, resume.fileName);
            parsed = p; rawText = rt;
          }
        } else {
          const { data: urlData } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
          const { parsed: p, rawText: rt } = await parseWithClaude(urlData.publicUrl, resume.fileName);
          parsed = p; rawText = rt;
        }

        const skills = Array.isArray(parsed?.skills)
          ? parsed.skills.map((s: any) => String(s)).filter(Boolean).slice(0, 25) : [];
        const normalizedRawText = (rawText ?? JSON.stringify(parsed)).slice(0, 50000);
        const fullName = [parsed.first_name, parsed.last_name].filter(Boolean).join(" ");

        if (!fullName && !parsed.email) {
          await supabase.from("resumes").update({ parsing_status: "skipped" }).eq("id", resume.id);
          continue;
        }

        // ★ BLACKLIST CHECK — never recreate intentionally deleted candidates
        const blacklisted = await isBlacklisted(supabase, parsed, resume.fileName);
        if (blacklisted) {
          console.log(`[reconcile] ⛔ blacklisted: ${fullName || parsed.email} (${resume.fileName})`);
          await supabase.from("resumes").update({ parsing_status: "skipped" }).eq("id", resume.id);
          blacklisted_skipped++;
          continue;
        }

        let candidateId = await findExistingCandidate(supabase, parsed);
        let action = "matched";

        if (candidateId) {
          const { data: existing } = await supabase.from("candidates")
            .select("current_title, current_company, location_text, skills, resume_url")
            .eq("id", candidateId).maybeSingle();
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
          const { data: pub } = supabase.storage.from("resumes").getPublicUrl(resume.file_path);
          const { data: newCand, error: insertErr } = await supabase.from("candidates").insert({
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
          }).select("id").single();
          if (insertErr || !newCand) throw new Error(`Create candidate failed: ${insertErr?.message}`);
          candidateId = newCand.id;
          action = "created";
          created++;
        }

        await supabase.from("resumes").update({
          candidate_id: candidateId,
          raw_text: normalizedRawText,
          parsed_json: parsed,
          parsing_status: "completed",
          updated_at: new Date().toISOString(),
        }).eq("id", resume.id);

        try {
          const parts = [
            fullName ? `Name: ${fullName}` : "",
            parsed.current_title ? `Current Title: ${parsed.current_title}` : "",
            parsed.current_company ? `Current Company: ${parsed.current_company}` : "",
            parsed.location ? `Location: ${parsed.location}` : "",
            skills.length ? `Skills: ${skills.join(", ")}` : "",
            normalizedRawText ? `Resume:\n${normalizedRawText.slice(0, 20000)}` : "",
          ].filter(Boolean).join("\n\n");
          if (parts.trim().length >= 50) {
            const embedding = await getEmbedding(parts);
            await supabase.from("resume_embeddings").delete().eq("candidate_id", candidateId).eq("embed_type", "full_profile");
            await supabase.from("resume_embeddings").insert({
              candidate_id: candidateId, resume_id: resume.id,
              embedding: JSON.stringify(embedding),
              source_text: parts.slice(0, 2000), chunk_text: parts.slice(0, 2000),
              chunk_index: 0, embed_type: "full_profile", embed_model: VOYAGE_MODEL,
            });
            embedded++;
          }
        } catch (e: any) {
          console.warn(`[reconcile] embed failed:`, e?.message);
        }

        console.log(`[reconcile] ${resume.fileName} → ${action} → ${candidateId}`);

      } catch (err: any) {
        failed++;
        errors.push(`${resume.fileName}: ${err?.message ?? "unknown"}`);
        await supabase.from("resumes").update({ parsing_status: "failed" }).eq("id", resume.id);
      }

      await sleep(1500);
    }

    const { count: remaining } = await supabase.from("resumes")
      .select("id", { count: "exact", head: true })
      .is("candidate_id", null)
      .not("parsing_status", "in", '("failed","skipped")');

    return respond({ success: true, processed: allToProcess.length, matched, created, embedded, failed, blacklisted_skipped, junk_flagged: junkIds.length, remaining: remaining ?? 0, errors: errors.slice(0, 10) });

  } catch (err: any) {
    console.error("[reconcile-orphaned-resumes] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500 );
  }
});
