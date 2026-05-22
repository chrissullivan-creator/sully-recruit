import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getVoyageKey,
} from "../../../../src/server-lib/supabase.js";

/**
 * Embed existing people.joe_says briefs into people.joe_says_embedding
 * so Ask Joe's RAG can vector-match against the recruiter-edited
 * summary in addition to the raw resume_embeddings. Only a small
 * backlog at first run (~161 rows when this ships) but the cron
 * keeps it drained as new briefs land and old ones edit.
 *
 * Runs every 15 minutes, BATCH 50. Voyage's rate ceiling is far above
 * that, and the brief is short enough (~3K chars max) that a batch
 * of 50 fits in one Voyage request comfortably.
 */
export const backfillJoeSaysEmbeddings = inngest.createFunction(
  { id: "backfill-joe-says-embeddings", name: "Backfill joe_says embeddings (Inngest)" },
  { cron: "5-59/15 * * * *" },
  async ({ logger }) => {
    const supabase = getSupabaseAdmin();
    const BATCH_SIZE = 50;

    const voyageKey = await getVoyageKey().catch(() => "");
    if (!voyageKey) {
      logger.warn("No VOYAGE_API_KEY — cannot backfill");
      return { skipped: true, reason: "no_voyage_key" };
    }

    const { data: rows, error } = await supabase
      .from("people")
      .select("id, joe_says")
      .not("joe_says", "is", null)
      .is("joe_says_embedding", null)
      .order("joe_says_updated_at", { ascending: false, nullsFirst: false })
      .limit(BATCH_SIZE);

    if (error) throw new Error(`Query error: ${error.message}`);
    if (!rows?.length) {
      logger.info("No joe_says rows to embed");
      return { embedded: 0 };
    }

    // Voyage accepts an array of inputs in a single request. Map the
    // index back to the row id so we can write each embedding.
    const inputs = rows.map((r: any) => String(r.joe_says ?? "").slice(0, 8000));
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${voyageKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "voyage-finance-2",
        input: inputs,
        input_type: "document",
      }),
    });
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 400);
      throw new Error(`Voyage ${resp.status}: ${body}`);
    }
    const data = await resp.json();
    const items: { index: number; embedding: number[] }[] = data?.data ?? [];
    if (items.length !== rows.length) {
      logger.warn("Voyage returned mismatched batch size", {
        requested: rows.length,
        got: items.length,
      });
    }

    let written = 0;
    const now = new Date().toISOString();
    for (const item of items) {
      const row = rows[item.index];
      if (!row || !Array.isArray(item.embedding) || item.embedding.length !== 1024) continue;
      const vecLit = `[${item.embedding.join(",")}]`;
      const { error: upErr } = await supabase
        .from("people")
        .update({
          joe_says_embedding: vecLit,
          joe_says_embedded_at: now,
        } as any)
        .eq("id", row.id);
      if (upErr) {
        logger.warn("Update failed", { id: row.id, error: upErr.message });
        continue;
      }
      written += 1;
    }

    logger.info("joe_says embedding batch done", { batch: rows.length, written });
    return { embedded: written, batch: rows.length };
  },
);
