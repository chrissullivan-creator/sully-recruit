import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getVoyageKey,
} from "../../../../src/server-lib/supabase.js";

/**
 * Drain the search_documents.embedding backlog so the Sully Brain custom
 * GPT's hybrid search actually has vectors to match against. The table is
 * populated by source-table triggers but the embedding column is filled
 * out-of-band; without this cron only ~5% of rows have vectors and the
 * /api/brain/search endpoint silently falls back to FTS-only.
 *
 * Runs every 5 minutes, BATCH 96. Voyage's per-request hard cap is 128
 * inputs and 120k tokens; bodies are clipped to 8k chars (~2k tokens), so
 * 96 fits comfortably with margin. At ~12.5k rows missing today this
 * drains in roughly 11 hours of cron ticks, then settles into trickle
 * mode as new rows land.
 *
 * Order: source_updated_at DESC so the most-recently-edited content
 * lands in the vector index first — that's the stuff users are most
 * likely to ask about right after a backfill.
 */
const BATCH_SIZE = 96;
const MAX_MANUAL_BATCHES = 5;

// We deliberately exclude `message` rows from this cron — there are ~17k
// messages NOT linked to a person in the DB yet (the upstream Unipile +
// Microsoft Graph + LinkedIn Recruiter sync is what backfills the
// person link, not us). Embedding orphan messages wastes Voyage budget
// and pollutes search results. Let the message sync land first; a
// separate cron can pick them up once they're linked.
const KINDS_TO_EMBED = [
  "candidate",
  "contact",
  "company",
  "resume",
  "call",
  "note",
  "send_out",
  "job",
];

async function runOneBatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  voyageKey: string,
  logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void },
): Promise<{ written: number; batch: number; byKind: Record<string, number>; drained?: boolean }> {
  const { data: rows, error } = await supabase
    .from("search_documents")
    .select("id, source_kind, title, subtitle, body")
    .is("embedding", null)
    .not("body", "is", null)
    .in("source_kind", KINDS_TO_EMBED)
    .order("source_updated_at", { ascending: false, nullsFirst: false })
    .limit(BATCH_SIZE);

  if (error) throw new Error(`Query error: ${error.message}`);
  if (!rows?.length) {
    logger.info("search_documents embedding backlog drained");
    return { written: 0, batch: 0, byKind: {}, drained: true };
  }

  // Concat title + subtitle + body so the embedding captures the
  // top-line summary, not just the long-form body. The body alone
  // sometimes loses the entity's identity (e.g. a message body that
  // never mentions the sender's company).
  const inputs = rows
    .map((r: any) => {
      const parts = [r.title, r.subtitle, r.body]
        .filter((p) => typeof p === "string" && p.trim())
        .map((p) => String(p).trim());
      return parts.join("\n\n").slice(0, 8000);
    })
    .map((s) => s || " ");

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

  let written = 0;
  const now = new Date().toISOString();
  for (const item of items) {
    const row = rows[item.index];
    if (!row || !Array.isArray(item.embedding) || item.embedding.length !== 1024) continue;
    const vecLit = `[${item.embedding.join(",")}]`;
    const { error: upErr } = await supabase
      .from("search_documents")
      .update({ embedding: vecLit, indexed_at: now } as any)
      .eq("id", row.id);
    if (upErr) {
      logger.warn("Update failed", { id: row.id, error: upErr.message });
      continue;
    }
    written += 1;
  }

  const byKind: Record<string, number> = {};
  for (const r of rows as any[]) {
    const k = r.source_kind ?? "unknown";
    byKind[k] = (byKind[k] ?? 0) + 1;
  }

  return { written, batch: rows.length, byKind };
}

export const backfillSearchDocumentsEmbeddings = inngest.createFunction(
  {
    id: "backfill-search-documents-embeddings",
    name: "Backfill search_documents embeddings (Inngest)",
  },
  [
    { cron: "*/5 * * * *" },
    { event: "ops/backfill-search-embeddings.requested" },
  ],
  async ({ event, logger, step }) => {
    const supabase = getSupabaseAdmin();
    const voyageKey = await getVoyageKey().catch(() => "");
    if (!voyageKey) {
      logger.warn("No VOYAGE_API_KEY — cannot backfill search_documents");
      return { skipped: true, reason: "no_voyage_key" };
    }

    // Manual triggers can request up to MAX_MANUAL_BATCHES batches in
    // one invocation (~480 rows, ~30-60s on Voyage). Cron ticks always
    // do exactly one batch — pacing matters more there.
    const isManual = event?.name === "ops/backfill-search-embeddings.requested";
    const requested = isManual ? Number((event as any)?.data?.batches ?? 1) : 1;
    const batches = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), MAX_MANUAL_BATCHES);

    let totalWritten = 0;
    let batchesRun = 0;
    const aggKind: Record<string, number> = {};
    let drained = false;

    for (let i = 0; i < batches; i++) {
      const r = await step.run(`embed-batch-${i + 1}`, () =>
        runOneBatch(supabase, voyageKey, logger),
      );
      totalWritten += r.written;
      if (r.batch > 0) batchesRun += 1;
      for (const [k, n] of Object.entries(r.byKind)) {
        aggKind[k] = (aggKind[k] ?? 0) + (n as number);
      }
      if (r.drained) {
        drained = true;
        break;
      }
    }

    logger.info("search_documents backfill done", {
      trigger: isManual ? "manual" : "cron",
      batches_planned: batches,
      batches_run: batchesRun,
      written: totalWritten,
      byKind: aggKind,
      drained,
    });
    return { embedded: totalWritten, batches_run: batchesRun, drained, byKind: aggKind };
  },
);
