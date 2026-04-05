import type { VercelRequest, VercelResponse } from "@vercel/node";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Vercel serverless function to trigger the send-message Trigger.dev task.
 * Replaces the Supabase Edge Function send-message for better retry and monitoring.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

    const handle = await tasks.trigger("send-message", {
      channel,
      conversationId: conversation_id,
      candidateId: candidate_id,
      contactId: contact_id,
      to,
      subject,
      body,
      accountId: account_id,
      userId: user_id,
    });

    return res.status(200).json({ triggered: true, id: handle.id });
  } catch (err: any) {
    console.error("Trigger send-message error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
