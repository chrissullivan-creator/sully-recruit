import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";
import { getSupabaseAdmin } from "../src/trigger/lib/supabase.js";

/**
 * POST /api/trigger-backfill-recent-people
 *
 * Sweep people whose message history has never been synced
 * (`last_history_synced_at IS NULL`) and fan out
 * `messages/fetch-entity-history.requested` events so email + LinkedIn
 * history lands now instead of waiting on the hourly cron (which only
 * processes 50 people/hour).
 *
 * Body: { limit?: number }   // default 200, max 500
 * Auth: Supabase JWT (any signed-in user)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const rawLimit = Number(req.body?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 500)
      : 200;

    const supabase = getSupabaseAdmin();

    const { data: people, error } = await supabase
      .from("people")
      .select("id, type, primary_email, work_email, personal_email, linkedin_url")
      .is("last_history_synced_at", null)
      .neq("is_stub", true)
      .or("primary_email.not.is.null,work_email.not.is.null,personal_email.not.is.null,linkedin_url.not.is.null")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("Backfill recent-people query failed:", error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!people?.length) {
      return res.status(200).json({ triggered: true, dispatched: 0, message: "No unsynced people found" });
    }

    const stamp = Math.floor(Date.now() / 60_000);
    const events = people.map((p: any) => ({
      id: `entity-history-${p.id}-manual-${stamp}`,
      name: "messages/fetch-entity-history.requested" as const,
      data: {
        entity_id: p.id,
        entity_type: (p.type === "client" ? "contact" : "candidate") as "candidate" | "contact",
      },
    }));

    let dispatched = 0;
    const chunkSize = 500;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      await inngest.send(chunk);
      dispatched += chunk.length;
    }

    return res.status(200).json({ triggered: true, dispatched, limit });
  } catch (err: any) {
    console.error("Trigger backfill-recent-people error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
