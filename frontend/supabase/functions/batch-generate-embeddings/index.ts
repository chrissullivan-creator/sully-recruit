import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

async function getVoyageKey(): Promise<string | null> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "VOYAGE_API_KEY").maybeSingle();
  const fromDb = (data?.value ?? "").trim();
  if (fromDb) return fromDb;
  return (Deno.env.get("VOYAGE_API_KEY") ?? "").trim() || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const voyageKey = await getVoyageKey();
  if (!voyageKey) return new Response(JSON.stringify({ ok: false, error: "missing VOYAGE_API_KEY" }), { status: 500 });

  try {
    const body = await req.json().catch(() => ({}));
    const entity_type: string = body.entity_type ?? "candidates";
    const limit: number = Math.min(Math.max(body.batch_size ?? body.limit ?? 50, 1), 200);
    const embTable = entity_type === "candidates" ? "resume_embeddings" : "contact_embeddings";
    const embFk = entity_type === "candidates" ? "candidate_id" : "contact_id";

    const existingIds = new Set<string>();
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase.from(embTable).select(embFk).range(offset, offset + pageSize - 1);
      if (error) return new Response(JSON.stringify({ ok: false, error: `emb_scan: ${error.message}` }), { status: 500 });
      if (!data || data.length === 0) break;
      for (const r of data) {
        const v = (r as Record<string, string | null>)[embFk];
        if (v) existingIds.add(v);
      }
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    let missing: Record<string, unknown>[] = [];
    if (entity_type === "candidates") {
      const { data: withSummary } = await supabase.from("candidates")
        .select("id, full_name, candidate_summary, current_title, current_company, back_of_resume_notes")
        .not("candidate_summary", "is", null).limit(limit * 2);
      let filtered = (withSummary ?? []).filter((c: Record<string, unknown>) => !existingIds.has(c.id as string)).slice(0, limit);
      if (filtered.length < limit) {
        const remaining = limit - filtered.length;
        const { data: titleOnly } = await supabase.from("candidates")
          .select("id, full_name, candidate_summary, current_title, current_company, back_of_resume_notes")
          .not("current_title", "is", null).not("current_company", "is", null).is("candidate_summary", null)
          .limit(remaining * 3);
        const extras = (titleOnly ?? []).filter((c: Record<string, unknown>) => !existingIds.has(c.id as string)).slice(0, remaining);
        filtered = [...filtered, ...extras];
      }
      missing = filtered;
    } else {
      const { data: contacts } = await supabase.from("contacts").select("id, full_name, email, company_name, title").limit(limit * 2);
      missing = (contacts ?? []).filter((c: Record<string, unknown>) => !existingIds.has(c.id as string)).slice(0, limit);
    }

    if (!missing || missing.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0, total_existing: existingIds.size, message: "no entities need embeddings" }));
    }

    const processed: string[] = [];
    const errors: Array<{ id: string; reason: string }> = [];

    for (const entity of missing) {
      const e = entity as Record<string, unknown>;
      const text = entity_type === "candidates"
        ? [e.full_name, `${e.current_title ?? ""} at ${e.current_company ?? ""}`.trim(), e.candidate_summary ?? "", (e.back_of_resume_notes as string | undefined)?.slice(0, 500) ?? ""].filter(Boolean).join("\n")
        : `${e.full_name}\n${e.title ?? ""} at ${e.company_name ?? ""}\n${e.email ?? ""}`;

      if (text.trim().length < 10) { errors.push({ id: e.id as string, reason: "insufficient_text" }); continue; }

      const voyageResp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "Authorization": `Bearer ${voyageKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "voyage-finance-2", input: [text.slice(0, 8000)] }),
      });

      if (!voyageResp.ok) {
        const errText = await voyageResp.text().catch(() => "");
        errors.push({ id: e.id as string, reason: `voyage_${voyageResp.status}: ${errText.slice(0, 200)}` });
        continue;
      }

      const voyageData = await voyageResp.json();
      const embedding = voyageData.data?.[0]?.embedding;
      if (!embedding) { errors.push({ id: e.id as string, reason: "no_embedding_returned" }); continue; }

      const now = new Date().toISOString();
      const row = entity_type === "candidates"
        ? {
            candidate_id: e.id,
            source_text: text.slice(0, 4000),
            chunk_text: text.slice(0, 4000),
            chunk_index: 0,
            embedding: `[${embedding.join(",")}]`,
            embed_model: "voyage-finance-2",
            embed_type: e.candidate_summary ? "summary" : "profile",
            created_at: now,
            updated_at: now,
          }
        : {
            contact_id: e.id,
            text_content: text.slice(0, 1000),
            embedding: `[${embedding.join(",")}]`,
            model_used: "voyage-finance-2",
            created_at: now,
          };

      const insertResult = await supabase.from(embTable).insert(row);
      if (insertResult.error) errors.push({ id: e.id as string, reason: `insert: ${insertResult.error.message.slice(0, 200)}` });
      else processed.push(e.id as string);
    }

    return new Response(JSON.stringify({ ok: true, processed: processed.length, attempted: missing.length, total_existing: existingIds.size, errors: errors.slice(0, 5), entity_type }));
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), { status: 500 });
  }
});
