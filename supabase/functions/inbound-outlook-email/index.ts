import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { processInboundReply } from '../_shared/inbound-reply.ts';

serve(async (req) => {
  try {
    const payload = await req.json();
    const result = await processInboundReply({
      provider: 'outlook',
      channel: 'email',
      body: payload.body ?? payload.text ?? '',
      subject: payload.subject ?? null,
      senderAddress: payload.from?.email ?? payload.sender_address ?? null,
      recipientAddress: payload.to?.email ?? payload.recipient_address ?? null,
      senderName: payload.from?.name ?? payload.sender_name ?? null,
      externalMessageId: payload.message_id ?? payload.id ?? null,
      externalConversationId: payload.conversation_id ?? payload.thread_id ?? null,
      occurredAt: payload.received_at ?? payload.timestamp ?? null,
      rawPayload: payload,
      createFollowUpTask: Boolean(payload.create_follow_up_task),
      aiNotesEnabled: Boolean(payload.ai_notes_enabled),
    });

    return new Response(JSON.stringify({ success: true, ...result }), { status: 200 });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 400 });
  }
});
