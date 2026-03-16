import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { processInboundReply, type TrackedInboundChannel } from '../_shared/inbound-reply.ts';

function resolveLinkedinChannel(payload: any): TrackedInboundChannel {
  const source = String(payload.message_type ?? payload.channel_type ?? payload.channel ?? '').toLowerCase();
  if (source.includes('inmail') || source.includes('recruiter')) return 'linkedin_recruiter';
  return 'linkedin_message';
}

serve(async (req) => {
  try {
    const payload = await req.json();

    const direction = String(payload.direction ?? payload.event_direction ?? '').toLowerCase();
    if (direction && direction !== 'inbound') {
      return new Response(JSON.stringify({ success: true, skipped: 'non-inbound event' }), { status: 200 });
    }

    const result = await processInboundReply({
      provider: 'unipile',
      channel: resolveLinkedinChannel(payload),
      body: payload.text ?? payload.body ?? payload.message ?? '',
      senderAddress: payload.sender?.provider_id ?? payload.sender?.linkedin_id ?? payload.sender_id ?? null,
      recipientAddress: payload.recipient?.provider_id ?? payload.recipient_id ?? null,
      senderName: payload.sender?.name ?? null,
      externalMessageId: payload.message_id ?? payload.id ?? null,
      externalConversationId: payload.conversation_id ?? payload.chat_id ?? null,
      occurredAt: payload.created_at ?? payload.timestamp ?? null,
      rawPayload: payload,
      createFollowUpTask: Boolean(payload.create_follow_up_task),
      aiNotesEnabled: Boolean(payload.ai_notes_enabled),
    });

    return new Response(JSON.stringify({ success: true, ...result }), { status: 200 });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 400 });
  }
});
