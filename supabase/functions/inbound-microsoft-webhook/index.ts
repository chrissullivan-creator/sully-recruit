import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleInboundReply } from '../_shared/inbound-reply.ts';

serve(async (req) => {
  if (req.method === 'GET') {
    const validationToken = new URL(req.url).searchParams.get('validationToken');
    if (validationToken) return new Response(validationToken, { status: 200 });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const payload = await req.json();
    const events = Array.isArray(payload?.value) ? payload.value : [payload];

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const results = [] as unknown[];
    for (const evt of events) {
      const msg = evt?.resourceData ?? evt;
      if (!msg || msg?.isDraft || msg?.eventType === 'delivery_receipt' || msg?.eventType === 'read_receipt') continue;

      const from = msg?.from?.emailAddress?.address;
      const to = msg?.toRecipients?.[0]?.emailAddress?.address;
      const externalMessageId = msg?.id || msg?.internetMessageId;
      if (!from || !externalMessageId) continue;

      const result = await handleInboundReply(supabase, {
        provider: 'microsoft',
        channel: 'email',
        externalMessageId: String(externalMessageId),
        externalThreadId: msg?.conversationId ?? null,
        fromIdentity: from,
        toIdentity: to ?? null,
        subject: msg?.subject ?? null,
        body: msg?.bodyPreview ?? msg?.body?.content ?? '',
        sentAt: msg?.receivedDateTime ?? msg?.createdDateTime ?? new Date().toISOString(),
        rawPayload: evt,
      });

      results.push(result);
    }

    return new Response(JSON.stringify({ ok: true, processed: results.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('microsoft inbound webhook error', error);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
});
