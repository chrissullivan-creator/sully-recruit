import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "./lib/auth.js";
import { inngest } from "./lib/inngest/client.js";
import { getSupabaseAdmin } from "../src/server-lib/supabase.js";
import { sendSendoutEmail, type SendoutAttachment } from "../src/server-lib/send-sendout-email.js";

/**
 * POST /api/send-sendout
 *
 * Sends (or schedules) a client submission email for a send-out, with the
 * formatted résumé attached. Supports two recipient modes and a snapshot of the
 * email written to `send_outs.submission_email` for the Submission drawer.
 *
 *  - mode 'together'   → one email to all recipients (+ cc)
 *  - mode 'individual' → a separate email to each recipient
 *  - send_at (future ISO) → queue a `scheduled_messages` row + delayed Inngest event
 */
interface SendSendoutBody {
  to: string[];
  cc?: string[];
  subject: string;
  body_html: string;
  attachments?: SendoutAttachment[];
  mode?: "individual" | "together";
  send_at?: string | null;
  candidate_id?: string | null;
  job_id?: string | null;
  send_out_id?: string | null;
  use_signature?: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const userId = auth.userId;
  if (!userId) return res.status(400).json({ error: "A logged-in user is required to send" });

  try {
    const body = (req.body ?? {}) as SendSendoutBody;
    const to = (body.to || []).map((s) => String(s).trim()).filter(Boolean);
    const cc = (body.cc || []).map((s) => String(s).trim()).filter(Boolean);
    const mode = body.mode === "individual" ? "individual" : "together";
    const attachments = body.attachments || [];

    if (to.length === 0) return res.status(400).json({ error: "At least one recipient is required" });
    if (!body.subject) return res.status(400).json({ error: "Subject is required" });
    if (!body.body_html) return res.status(400).json({ error: "Email body is required" });

    const admin = getSupabaseAdmin();

    // Recipient groups: one email per recipient (individual) or one to all (together).
    const groups: { to: string[]; cc: string[] }[] =
      mode === "individual" ? to.map((addr) => ({ to: [addr], cc: [] })) : [{ to, cc }];

    const sendAt = body.send_at ? new Date(body.send_at) : null;
    const isScheduled = !!sendAt && !isNaN(sendAt.getTime()) && sendAt.getTime() > Date.now() + 30_000;

    if (isScheduled && sendAt) {
      // Queue each group + fire a delayed Inngest event keyed to the row.
      for (const g of groups) {
        const { data: row, error } = await admin
          .from("scheduled_messages")
          .insert({
            user_id: userId,
            candidate_id: body.candidate_id ?? null,
            job_id: body.job_id ?? null,
            send_out_id: body.send_out_id ?? null,
            to_emails: g.to,
            cc_emails: g.cc,
            subject: body.subject,
            body_html: body.body_html,
            // Encode "path::name" so the worker can rebuild the attachment.
            attachment_paths: attachments.map((a) => `${a.path}::${a.name}`),
            scheduled_at: sendAt.toISOString(),
            status: "scheduled",
          } as any)
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        await inngest.send({
          name: "messages/send.scheduled.requested",
          data: { scheduledMessageId: (row as any).id, useSignature: !!body.use_signature },
          ts: sendAt.getTime(),
        });
      }
      await writeSnapshot(admin, body, to, cc, { scheduled_at: sendAt.toISOString() });
      return res.status(200).json({ scheduled: true, count: groups.length, scheduled_at: sendAt.toISOString() });
    }

    // Immediate send.
    let sender = "";
    for (const g of groups) {
      const result = await sendSendoutEmail(admin, {
        userId,
        to: g.to,
        cc: g.cc,
        subject: body.subject,
        html: body.body_html,
        attachments,
        useSignature: !!body.use_signature,
      });
      sender = result.sender;
    }
    await writeSnapshot(admin, body, to, cc, { sent_at: new Date().toISOString(), from: sender });
    return res.status(200).json({ sent: true, count: groups.length });
  } catch (err: any) {
    console.error("send-sendout error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function writeSnapshot(
  admin: any,
  body: SendSendoutBody,
  to: string[],
  cc: string[],
  extra: { sent_at?: string; scheduled_at?: string; from?: string },
) {
  if (!body.send_out_id) return;
  const snapshot = {
    subject: body.subject,
    body_html: body.body_html,
    to,
    cc,
    resume_file_name: body.attachments?.[0]?.name ?? null,
    ...extra,
  };
  const { error } = await admin
    .from("send_outs")
    .update({ submission_email: snapshot } as any)
    .eq("id", body.send_out_id);
  if (error) console.error("send-sendout: snapshot write failed:", error.message);
}
