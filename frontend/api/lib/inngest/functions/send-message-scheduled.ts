import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { sendSendoutEmail, type SendoutAttachment } from "../../../../src/server-lib/send-sendout-email.js";

/**
 * Fires at a `scheduled_messages` row's scheduled time (the event is dispatched
 * with a future `ts` by /api/send-sendout) and performs the deferred client
 * submission email via Microsoft Graph. Idempotent-ish: skips rows that are no
 * longer `scheduled` (canceled or already sent), and stamps the result back.
 */
export const sendMessageScheduled = inngest.createFunction(
  { id: "send-message-scheduled", name: "Send scheduled submission email", retries: 3 },
  { event: "messages/send.scheduled.requested" },
  async ({ event, logger }) => {
    const { scheduledMessageId, useSignature } = event.data as {
      scheduledMessageId: string;
      useSignature?: boolean;
    };
    const supabase = getSupabaseAdmin();

    const { data: row, error } = await supabase
      .from("scheduled_messages")
      .select("*")
      .eq("id", scheduledMessageId)
      .maybeSingle();
    if (error) throw new Error(`scheduled_messages lookup failed: ${error.message}`);
    if (!row) {
      logger.warn("scheduled message not found — skipping", { scheduledMessageId });
      return { skipped: "not_found" };
    }
    if ((row as any).status !== "scheduled") {
      logger.info("scheduled message no longer pending — skipping", {
        scheduledMessageId,
        status: (row as any).status,
      });
      return { skipped: (row as any).status };
    }

    const r = row as any;
    const attachments: SendoutAttachment[] = (r.attachment_paths || []).map((enc: string) => {
      const idx = enc.lastIndexOf("::");
      const path = idx >= 0 ? enc.slice(0, idx) : enc;
      const name = idx >= 0 ? enc.slice(idx + 2) : path.split("/").pop() || "attachment.pdf";
      return { path, name };
    });

    try {
      await sendSendoutEmail(supabase, {
        userId: r.user_id,
        to: r.to_emails || [],
        cc: r.cc_emails || [],
        subject: r.subject || "",
        html: r.body_html || "",
        attachments,
        useSignature: !!useSignature,
      });

      await supabase
        .from("scheduled_messages")
        .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() } as any)
        .eq("id", scheduledMessageId);

      // Update the Submission drawer snapshot to reflect actual delivery.
      if (r.send_out_id) {
        const snapshot = {
          subject: r.subject,
          body_html: r.body_html,
          to: r.to_emails || [],
          cc: r.cc_emails || [],
          resume_file_name: attachments[0]?.name ?? null,
          sent_at: new Date().toISOString(),
        };
        await supabase.from("send_outs").update({ submission_email: snapshot } as any).eq("id", r.send_out_id);
      }

      logger.info("scheduled submission email sent", { scheduledMessageId });
      return { sent: true };
    } catch (err: any) {
      await supabase
        .from("scheduled_messages")
        .update({ status: "failed", error: err.message, updated_at: new Date().toISOString() } as any)
        .eq("id", scheduledMessageId);
      throw err;
    }
  },
);
