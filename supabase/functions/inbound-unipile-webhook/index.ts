import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleInboundReply } from '../_shared/inbound-reply.ts';

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const payload = await req.json();
    const eventType = String(payload?.event ?? payload?.type ?? '').toLowerCase();

    // Only process real inbound messages/replies
    const isReceipt = /receipt|read|delivery|status/.test(eventType);
    const isOutbound = /outbound|sent/.test(eventType) || payload?.data?.direction === 'outbound';
    const isMessage = /message|inmail/.test(eventType) || !!payload?.data?.message_id;

    if (!isMessage || isReceipt || isOutbound) {
      return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    const data = payload?.data ?? payload;
    const isInmail = /inmail/.test(eventType) || data?.message_type === 'inmail';

    const externalMessageId = data?.message_id ?? data?.id;
    const fromIdentity = data?.sender_id ?? data?.from?.id ?? data?.from;
    if (!externalMessageId || !fromIdentity) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: 'not_a_message' }), { headers: { 'Content-Type': 'application/json' } });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const result = await handleInboundReply(supabase, {
      provider: 'unipile',
      channel: isInmail ? 'linkedin_inmail' : 'linkedin_message',
      externalMessageId: String(externalMessageId),
      externalThreadId: data?.conversation_id ?? data?.chat_id ?? null,
      fromIdentity: String(fromIdentity),
      toIdentity: data?.recipient_id ?? data?.to?.id ?? null,
      body: data?.body ?? data?.text ?? '',
      sentAt: data?.timestamp ?? data?.created_at ?? new Date().toISOString(),
      rawPayload: payload,
    });

    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('unipile inbound webhook error', error);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
