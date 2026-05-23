import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";
import { getSupabaseAdmin } from "../src/server-lib/supabase.js";

/**
 * POST /api/trigger-backfill-search-embeddings
 *
 * Kick the search_documents embedding backfill on demand instead of
 * waiting for the next 5-minute cron tick. Useful right after deploying
 * the Sully Brain custom GPT, when most rows are still un-embedded.
 *
 * Body: { batches?: number }   // default 1, max 5 per invocation (~480 rows / 30-60s)
 *
 * To drain the full backlog, call this repeatedly — or just let the
 * cron run (it self-drains over ~11 hours at the 12.5k-row mark).
 *
 * Auth: Supabase JWT or service-role key.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  try {
    const requested = Number(req.body?.batches);
    const batches = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 5)
      : 1;

    // Sanity check: how much is left?
    const supabase = getSupabaseAdmin();
    const { count } = await supabase
      .from("search_documents")
      .select("id", { count: "exact", head: true })
      .is("embedding", null)
      .not("body", "is", null);

    await inngest.send({
      id: `backfill-search-embeddings-manual-${Math.floor(Date.now() / 1_000)}`,
      name: "ops/backfill-search-embeddings.requested",
      data: { batches },
    });

    return res.status(200).json({
      triggered: true,
      batches_requested: batches,
      backlog_remaining: count ?? null,
      note:
        "Inngest will process up to ~96 rows per batch. Call again until backlog_remaining hits 0, or let the 5-min cron drain it.",
    });
  } catch (err: any) {
    console.error("trigger-backfill-search-embeddings error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
