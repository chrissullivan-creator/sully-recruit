import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";
import { inngest } from "../lib/inngest/client.js";

/**
 * POST /api/brain/sync-history
 *
 * Kick the message-history backfill for people who have never been
 * synced. Fires `messages/fetch-entity-history.requested` events
 * for up to `limit` people; the existing fetch-entity-history Inngest
 * function handles the per-person Unipile fan-out under concurrency
 * caps.
 *
 * Body: { limit?: number (default 200, max 500), only_with_linkedin?: boolean }
 *
 * Returns: { dispatched, backlog_remaining }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  try {
    const requested = Number(req.body?.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 500)
      : 200;
    const onlyWithLinkedin = req.body?.only_with_linkedin === true;

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    let pickQ = supabase
      .from("people")
      .select("id, type, primary_email, work_email, personal_email, linkedin_url")
      .is("last_history_synced_at", null)
      .neq("is_stub", true)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (onlyWithLinkedin) {
      pickQ = pickQ.not("linkedin_url", "is", null).neq("linkedin_url", "");
    } else {
      pickQ = pickQ.or(
        "primary_email.not.is.null,work_email.not.is.null,personal_email.not.is.null,linkedin_url.not.is.null",
      );
    }

    const { data: people, error } = await pickQ;
    if (error) return res.status(500).json({ error: error.message });

    if (!people?.length) {
      return res.status(200).json({ dispatched: 0, backlog_remaining: 0, note: "no unsynced people found" });
    }

    const stamp = Math.floor(Date.now() / 60_000);
    const events = people.map((p: any) => ({
      id: `entity-history-${p.id}-brain-${stamp}`,
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

    const { count: remaining } = await supabase
      .from("people")
      .select("id", { count: "exact", head: true })
      .is("last_history_synced_at", null)
      .neq("is_stub", true);

    return res.status(200).json({
      dispatched,
      backlog_remaining: Math.max((remaining ?? 0) - dispatched, 0),
      note: "Inngest will pull email + LinkedIn history per person. Call again to drain more.",
    });
  } catch (err: any) {
    console.error("brain/sync-history error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
