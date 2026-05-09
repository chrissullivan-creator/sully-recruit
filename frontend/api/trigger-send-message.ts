import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "../src/inngest/client";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire `message/send-requested` into
 * Inngest. Migrated from Trigger.dev as part of Phase 4.
 *
 * The Inngest function (frontend/src/inngest/functions/send-message.ts)
 * is a thin wrapper around `runSendMessage` from the legacy file —
 * one source of truth, both engines call it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await requireAuth(req, res))) return;

  try {
    const {
      channel,
      conversation_id,
      candidate_id,
      contact_id,
      to,
      subject,
      body,
      account_id,
      user_id,
    } = req.body;

    if (!channel || !body || !user_id) {
      return res
        .status(400)
        .json({ error: "Missing required fields: channel, body, user_id" });
    }

    const { ids } = await inngest.send({
      name: "message/send-requested",
      data: {
        channel,
        conversationId: conversation_id,
        candidateId: candidate_id,
        contactId: contact_id,
        to,
        subject,
        body,
        accountId: account_id,
        userId: user_id,
      },
    });

    return res.status(200).json({ triggered: true, id: ids[0] });
  } catch (err: any) {
    console.error("Trigger message/send-requested error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
