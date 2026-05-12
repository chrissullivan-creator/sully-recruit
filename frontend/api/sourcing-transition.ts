import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/sourcing-transition
 *
 * Single-button transitions out of the sourcing funnel:
 *   - withdraw          → marks the row withdrawn_at; equivalent to
 *                         send_outs.withdrawn_reason. Available from
 *                         `replied` onwards (per product spec).
 *   - promote_to_pitch  → inserts a pitches row + stamps sourcing as
 *                         promoted_to='pitch'. Available from
 *                         `back_of_resume` onwards.
 *   - promote_to_send_out → inserts a send_outs row at stage='new' +
 *                         stamps sourcing as promoted_to='send_out'.
 *                         Available from `back_of_resume` onwards.
 *
 * Body:
 *   sourcing_id (uuid, required)
 *   action      (one of the three above)
 *   reason?     (text — withdrawal reason)
 *   notes?      (text — passed through to pitches.notes)
 *
 * Auth: Supabase JWT.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const { sourcing_id, action, reason, notes } = req.body || {};
  if (!sourcing_id) return res.status(400).json({ error: "Missing sourcing_id" });
  if (!action) return res.status(400).json({ error: "Missing action" });

  try {
    // Pull the row first so we can enforce stage gates server-side.
    const { data: row, error: fetchErr } = await supabase
      .from("sourcing")
      .select("id, candidate_id, job_id, stage, withdrawn_at, promoted_at, promoted_to")
      .eq("id", sourcing_id)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: "Sourcing row not found" });

    if (row.withdrawn_at) {
      return res.status(409).json({ error: "Row is already withdrawn." });
    }
    if (row.promoted_at) {
      return res.status(409).json({ error: `Row already promoted to ${row.promoted_to}.` });
    }

    if (action === "withdraw") {
      // Per spec: withdraw becomes available once the candidate replied.
      if (!["replied", "back_of_resume"].includes(row.stage)) {
        return res.status(409).json({
          error: `Cannot withdraw a row in stage "${row.stage}". Withdraw is available once they've replied.`,
        });
      }
      const { error: updErr } = await supabase
        .from("sourcing")
        .update({
          withdrawn_at: new Date().toISOString(),
          withdrawn_reason: reason || null,
          withdrawn_by: user.id,
        } as any)
        .eq("id", sourcing_id);
      if (updErr) throw updErr;
      return res.status(200).json({ ok: true, action: "withdraw" });
    }

    if (action === "promote_to_pitch" || action === "promote_to_send_out") {
      // Promotion only after back_of_resume per spec.
      if (row.stage !== "back_of_resume") {
        return res.status(409).json({
          error: `Promote is only available from back_of_resume (current stage: "${row.stage}").`,
        });
      }

      let promotedId: string | null = null;

      if (action === "promote_to_pitch") {
        const { data: pitchRow, error: pErr } = await supabase
          .from("pitches")
          .insert({
            candidate_id: row.candidate_id,
            job_id: row.job_id,
            pitched_by: user.id,
            notes: notes || null,
          } as any)
          .select("id")
          .single();
        if (pErr) throw pErr;
        promotedId = pitchRow.id;
      } else {
        const { data: sendOutRow, error: sErr } = await supabase
          .from("send_outs")
          .insert({
            candidate_id: row.candidate_id,
            job_id: row.job_id,
            stage: "new",
            recruiter_id: user.id,
          } as any)
          .select("id")
          .single();
        if (sErr) throw sErr;
        promotedId = sendOutRow.id;
      }

      const { error: stampErr } = await supabase
        .from("sourcing")
        .update({
          promoted_at: new Date().toISOString(),
          promoted_to: action === "promote_to_pitch" ? "pitch" : "send_out",
          promoted_to_id: promotedId,
        } as any)
        .eq("id", sourcing_id);
      if (stampErr) throw stampErr;

      return res.status(200).json({
        ok: true,
        action,
        promoted_to_id: promotedId,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error("sourcing-transition error:", err);
    return res.status(500).json({ error: err.message || "Transition failed" });
  }
}
