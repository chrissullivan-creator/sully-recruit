import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleInboundReply } from '../_shared/inbound-reply.ts';

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const payload = await req.json();

    // Ignore status and receipt webhooks
    const eventType = payload?.event || payload?.eventType || '';
    if (/delivery|receipt|read|status/i.test(eventType)) {
      return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    const body = payload?.body ?? payload;
    const direction = body?.direction ?? body?.messageStatus;
    if (direction && String(direction).toLowerCase() !== 'inbound') {
      return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    const fromPhone = body?.from?.phoneNumber ?? body?.from?.phone_number;
    const toPhone = body?.to?.[0]?.phoneNumber ?? body?.to?.phoneNumber;
    const externalMessageId = body?.id ?? body?.messageId;
    if (!fromPhone || !externalMessageId) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: 'not_a_message' }), { headers: { 'Content-Type': 'application/json' } });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const result = await handleInboundReply(supabase, {
      provider: 'ringcentral',
      channel: 'sms',
      externalMessageId: String(externalMessageId),
      externalThreadId: body?.conversationId ?? body?.conversation_id ?? null,
      fromIdentity: String(fromPhone),
      toIdentity: toPhone ? String(toPhone) : null,
      body: body?.subject ?? body?.text ?? body?.message ?? '',
      sentAt: body?.creationTime ?? body?.receivedAt ?? new Date().toISOString(),
      rawPayload: payload,
    });

    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('ringcentral inbound webhook error', error);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
