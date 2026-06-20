import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VOYAGE_MODEL = "voyage-finance-2";
const DELAY_MS = 300; // 200 RPM — safe for Voyage paid tier

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getVoyageKey(sb: any): Promise<string> {
  const { data } = await sb.from("app_settings").select("value").eq("key", "VOYAGE_API_KEY").single();
  if (!data?.value) throw new Error("VOYAGE_API_KEY not found in app_settings");
  return data.value;
}

async function getVoyageEmbedding(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [text], input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data[0].embedding;
}

function buildProfileText(candidate: any, rawText: string): string {
  const parts: string[] = [];
  if (candidate.full_name) parts.push(`Name: ${candidate.full_name}`);
  if (candidate.current_title) parts.push(`Current Title: ${candidate.current_title}`);
  if (candidate.current_company) parts.push(`Current Company: ${candidate.current_company}`);
  if (candidate.location_text) parts.push(`Location: ${candidate.location_text}`);
  if (candidate.skills?.length) parts.push(`Skills: ${candidate.skills.join(", ")}`);
  if (rawText) parts.push(`Resume:\n${rawText.slice(0, 20000)}`);
  return parts.join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Parse optional limit+offset from query string for batching
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "80");
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  // Use a streaming response so we don't idle-timeout
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const write = (obj: any) => writer.write(enc.encode(JSON.stringify(obj) + "\n"));

  (async () => {
    try {
      const voyageKey = await getVoyageKey(sb);

      // Find candidates with completed resume + raw_text but NO embedding
      const { data: resumes, error: resumeErr } = await sb
        .from("resumes")
        .select("id, candidate_id, raw_text")
        .eq("parsing_status", "completed")
        .not("raw_text", "is", null)
        .neq("raw_text", "")
        .neq("raw_text", "[PDF - parsed via Claude document API]")
        .not("candidate_id", "is", null)
        .order("created_at", { ascending: true });

      if (resumeErr) throw new Error(`Resume query error: ${resumeErr.message}`);

      // Deduplicate by candidate, skip already-embedded
      const allCandidateIds = [...new Set((resumes ?? []).map((r: any) => r.candidate_id))];
      const { data: existing } = await sb
        .from("resume_embeddings")
        .select("candidate_id")
        .in("candidate_id", allCandidateIds)
        .eq("embed_type", "full_profile");

      const embeddedSet = new Set((existing ?? []).map((e: any) => e.candidate_id));

      const candidateMap = new Map<string, any>();
      for (const r of (resumes ?? [])) {
        if (!embeddedSet.has(r.candidate_id)) {
          candidateMap.set(r.candidate_id, r);
        }
      }
      const allToProcess = [...candidateMap.values()];
      const toProcess = allToProcess.slice(offset, offset + limit);

      await write({ event: "start", total_eligible: allToProcess.length, batch_offset: offset, batch_limit: limit, batch_count: toProcess.length });

      if (toProcess.length === 0) {
        await write({ event: "done", embedded: 0, skipped: 0, failed: 0, remaining: 0 });
        await writer.close();
        return;
      }

      let embedded = 0, skipped = 0, failed = 0;

      for (let i = 0; i < toProcess.length; i++) {
        const resume = toProcess[i];
        try {
          const { data: candidate } = await sb
            .from("candidates")
            .select("id, full_name, current_title, current_company, location_text, skills")
            .eq("id", resume.candidate_id)
            .single();

          if (!candidate) { skipped++; continue; }

          const profileText = buildProfileText(candidate, resume.raw_text);
          if (profileText.trim().length < 50) { skipped++; continue; }

          const embedding = await getVoyageEmbedding(profileText, voyageKey);

          await sb.from("resume_embeddings").delete()
            .eq("candidate_id", candidate.id).eq("embed_type", "full_profile");

          await sb.from("resume_embeddings").insert({
            candidate_id: candidate.id,
            resume_id: resume.id,
            embedding: JSON.stringify(embedding),
            source_text: profileText.slice(0, 2000),
            chunk_text: profileText.slice(0, 2000),
            chunk_index: 0,
            embed_type: "full_profile",
            embed_model: "voyage-finance-2",
            updated_at: new Date().toISOString(),
          });

          embedded++;
          // Send progress every 10
          if (embedded % 10 === 0) {
            await write({ event: "progress", embedded, i: i + 1, total: toProcess.length });
          }
        } catch (err: any) {
          failed++;
          await write({ event: "error", candidate_id: resume.candidate_id, msg: err?.message });
        }

        if (i < toProcess.length - 1) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      }

      const remaining = Math.max(0, allToProcess.length - offset - limit);
      await write({ event: "done", embedded, skipped, failed, remaining, next_offset: offset + limit });
    } catch (err: any) {
      await write({ event: "fatal", error: err.message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
  });
});
