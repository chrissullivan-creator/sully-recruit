import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * run-job-candidate-match
 * For a single job_id or ALL hot jobs without matches:
 *  1. Embed the job (title + company + stripped description) via Voyage
 *  2. pgvector cosine-search → top K candidates
 *  3. Claude generates match blurb + score per candidate
 *  4. Upsert into job_candidate_matches
 */

function stripHtml(s: string): string {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function getSetting(sb: any, key: string): Promise<string | null> {
  const { data } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function embedText(voyageKey: string, text: string): Promise<number[] | null> {
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${voyageKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voyage-finance-2",
      input: [text.slice(0, 16000)],
      input_type: "query",
    }),
  });
  if (!r.ok) {
    console.error("Voyage embed failed", r.status, await r.text().catch(() => ""));
    return null;
  }
  const d = await r.json();
  return d.data?.[0]?.embedding ?? null;
}

async function generateBlurb(
  anthropicKey: string,
  jobTitle: string,
  jobCompany: string,
  jobDescription: string,
  candidate: any,
): Promise<{ score: number; blurb: string }> {
  const cand = [
    candidate.full_name ? `Name: ${candidate.full_name}` : null,
    candidate.current_title ? `Title: ${candidate.current_title}` : null,
    candidate.current_company ? `Company: ${candidate.current_company}` : null,
    candidate.candidate_summary ? `Summary: ${candidate.candidate_summary}` : null,
    candidate.source_text ? `Profile: ${candidate.source_text.slice(0, 800)}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are Joe, an old-school Wall Street recruiter. Score this candidate for this job on a 0-100 scale and write a 1-2 sentence punchy match rationale.

Job: ${jobTitle} at ${jobCompany}
Job description:
${jobDescription.slice(0, 1200)}

Candidate:
${cand}

Return ONLY valid JSON:
{"score": <0-100>, "blurb": "<1-2 sentence rationale>"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      console.warn("Claude blurb failed", r.status);
      return { score: 50, blurb: "Match pending AI review." };
    }
    const d = await r.json();
    const text = (d.content?.[0]?.text ?? "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 50)),
      blurb: String(parsed.blurb || "").slice(0, 500),
    };
  } catch (err) {
    console.warn("Blurb parse failed", err);
    return { score: 50, blurb: "Match pending AI review." };
  }
}

async function matchJob(
  sb: any,
  voyageKey: string,
  anthropicKey: string,
  job: any,
  topK: number,
): Promise<{ job_id: string; matches_created: number; error?: string }> {
  const jobTitle = job.title || "Untitled role";
  const jobCompany = job.company_name || "Unknown firm";
  const jobDesc = stripHtml(job.description || "");
  const jobText = `${jobTitle}\n${jobCompany}\n${jobDesc}`;

  // Embed job
  const jobEmb = await embedText(voyageKey, jobText);
  if (!jobEmb) {
    return { job_id: job.id, matches_created: 0, error: "Voyage embed failed" };
  }

  // Vector search
  const { data: matches, error: matchErr } = await sb.rpc("match_candidates_for_job", {
    query_embedding: `[${jobEmb.join(",")}]`,
    match_count: topK,
  });
  if (matchErr || !matches?.length) {
    return { job_id: job.id, matches_created: 0, error: matchErr?.message ?? "No matches" };
  }

  // Load candidate data
  const candIds = matches.map((m: any) => m.candidate_id);
  const { data: cands } = await sb
    .from("candidates")
    .select("id, full_name, current_title, current_company, candidate_summary, status")
    .in("id", candIds);
  const candMap = new Map((cands ?? []).map((c: any) => [c.id, c]));

  // Generate blurbs + insert
  let created = 0;
  for (const m of matches) {
    const c = candMap.get(m.candidate_id);
    if (!c) continue;
    const { score, blurb } = await generateBlurb(anthropicKey, jobTitle, jobCompany, jobDesc, c);
    const { error: upsertErr } = await sb.from("job_candidate_matches").upsert(
      {
        job_id: job.id,
        candidate_id: m.candidate_id,
        score,
        blurb,
        vector_similarity: Number(m.similarity) || null,
        matched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: "job_id,candidate_id" },
    );
    if (!upsertErr) created++;
    else console.warn("Upsert failed for", m.candidate_id, upsertErr.message);
  }

  return { job_id: job.id, matches_created: created };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const voyageKey = await getSetting(sb, "VOYAGE_API_KEY");
  const anthropicKey = await getSetting(sb, "ANTHROPIC_API_KEY");
  if (!voyageKey || !anthropicKey) {
    return new Response(JSON.stringify({ ok: false, error: "Missing API keys" }), { status: 500 });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body = all hot jobs */ }
  const { job_id, top_k = 10, force = false, max_jobs = 25 } = body;

  // Pick jobs
  let jobs: any[] = [];
  if (job_id) {
    const { data: j } = await sb.from("jobs").select("*").eq("id", job_id).maybeSingle();
    if (j) jobs = [j];
  } else {
    const { data: all } = await sb
      .from("jobs")
      .select("id, title, description, company_name, status")
      .eq("status", "hot")
      .not("description", "is", null);
    let candidates = all ?? [];
    if (!force) {
      const { data: matched } = await sb.from("job_candidate_matches").select("job_id");
      const matchedIds = new Set((matched ?? []).map((r: any) => r.job_id));
      candidates = candidates.filter((j: any) => !matchedIds.has(j.id));
    }
    jobs = candidates.slice(0, max_jobs);
  }

  if (!jobs.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0, message: "No eligible jobs" }));
  }

  const results: any[] = [];
  for (const job of jobs) {
    try {
      const r = await matchJob(sb, voyageKey, anthropicKey, job, top_k);
      results.push(r);
    } catch (err: any) {
      results.push({ job_id: job.id, matches_created: 0, error: err?.message ?? "unknown" });
    }
  }

  const totalCreated = results.reduce((s, r) => s + r.matches_created, 0);
  return new Response(
    JSON.stringify({
      ok: true,
      jobs_processed: jobs.length,
      total_matches_created: totalCreated,
      results,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
