import type { VercelRequest, VercelResponse } from "@vercel/node";
import { inngest } from "./lib/inngest/client.js";
import { requireAuth } from "./lib/auth.js";

/**
 * Vercel serverless function to fire the `messages/send.requested`
 * Inngest event. The Inngest function in
 * `api/lib/inngest/functions/send-message.ts` does the channel dispatch
 * (Microsoft Graph for email, RingCentral for SMS, Unipile for LinkedIn),
 * logs the message, updates entity timestamps, and chain-fires Joe Says.
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
      name: "messages/send.requested",
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
    console.error("Trigger send-message error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
