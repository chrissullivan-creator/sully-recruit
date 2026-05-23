import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * GET /api/brain/health
 *
 * Smoke test for the Sully Brain custom GPT setup. Returns DB connectivity,
 * row counts on key tables, and which AI provider keys are present. Useful
 * to call from the GPT first to verify wiring.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireAuth(req, res))) return;

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const [people, jobs, msgs, sd, embedded] = await Promise.all([
    supabase.from("candidates").select("id", { count: "exact", head: true }),
    supabase.from("jobs").select("id", { count: "exact", head: true }).is("deleted_at", null),
    supabase.from("messages").select("id", { count: "exact", head: true }),
    supabase.from("search_documents").select("id", { count: "exact", head: true }),
    supabase
      .from("search_documents")
      .select("id", { count: "exact", head: true })
      .not("embedding", "is", null),
  ]);

  return res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    counts: {
      people: people.count ?? null,
      active_jobs: jobs.count ?? null,
      messages: msgs.count ?? null,
      search_documents_total: sd.count ?? null,
      search_documents_embedded: embedded.count ?? null,
    },
    keys: {
      voyage: !!process.env.VOYAGE_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
    },
  });
}
