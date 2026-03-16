import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { processInboundReply } from '../_shared/inbound-reply.ts';

serve(async (req) => {
  try {
    const payload = await req.json();

    const direction = payload.direction || payload.eventDirection || payload.body?.direction;
    if (direction && String(direction).toLowerCase() !== 'inbound') {
      return new Response(JSON.stringify({ success: true, skipped: 'non-inbound event' }), { status: 200 });
    }

    const result = await processInboundReply({
      provider: 'ringcentral',
      channel: 'sms',
      body: payload.text ?? payload.body?.text ?? payload.body ?? '',
      senderAddress: payload.from?.phoneNumber ?? payload.from ?? payload.sender_address ?? null,
      recipientAddress: payload.to?.[0]?.phoneNumber ?? payload.to ?? payload.recipient_address ?? null,
      externalMessageId: payload.id?.toString?.() ?? payload.message_id ?? null,
      externalConversationId: payload.conversationId?.toString?.() ?? payload.conversation_id ?? null,
      occurredAt: payload.creationTime ?? payload.received_at ?? null,
      rawPayload: payload,
      createFollowUpTask: Boolean(payload.create_follow_up_task),
      aiNotesEnabled: Boolean(payload.ai_notes_enabled),
    });

    return new Response(JSON.stringify({ success: true, ...result }), { status: 200 });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 400 });
  }
});
