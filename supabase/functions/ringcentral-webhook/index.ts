import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, validation-token',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // RingCentral subscription validation handshake
  const validationToken = req.headers.get('validation-token');
  if (validationToken) {
    return new Response(null, {
      status: 200,
      headers: { ...corsHeaders, 'Validation-Token': validationToken },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const event = await req.json();
    console.log('[rc-webhook] event:', event?.event, JSON.stringify(event?.body).slice(0, 300));

    const eventPath: string = event?.event ?? '';
    const body = event?.body;

    if (!body) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (eventPath.includes('telephony')) {
      await handleTelephonySession(supabase, body);
    } else if (eventPath.includes('recording')) {
      await handleRecordingReady(supabase, body);
    } else if (eventPath.includes('ai') || eventPath.includes('summary')) {
      await handleAiSummary(supabase, body);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    console.error('[rc-webhook] error:', err);
    // Always return 200 so RC doesn't disable the subscription
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ---- Telephony session (call start / in-progress / disconnected) ----
async function handleTelephonySession(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const sessionId = (body.telephonySessionId ?? body.sessionId) as string | undefined;
  const parties = (body.parties as Record<string, unknown>[]) ?? [];

  for (const party of parties) {
    const statusObj = party.status as Record<string, unknown> | undefined;
    const statusCode = statusObj?.code as string | undefined;

    // Only process completed calls
    if (statusCode !== 'Disconnected') continue;

    const direction = ((party.direction as string) ?? '').toLowerCase(); // 'outbound' | 'inbound'
    const duration = (statusObj?.duration ?? null) as number | null;
    const fromPhone = (party.from as Record<string, unknown>)?.phoneNumber as string | null;
    const toPhone = (party.to as Record<string, unknown>)?.phoneNumber as string | null;
    const externalPhone = direction === 'outbound' ? toPhone : fromPhone;

    const recordings = (party.recordings as Record<string, unknown>[]) ?? [];
    const recordingUri = (recordings[0]?.contentUri as string) ?? null;

    // Match phone number to candidate or contact
    const { entityType, entityId, entityName } = await matchPhone(supabase, externalPhone);

    const upsertData: Record<string, unknown> = {
      external_call_id: sessionId,
      direction,
      phone_number: externalPhone ?? '',
      status: 'completed',
      duration_seconds: duration,
      ended_at: new Date().toISOString(),
    };

    if (!upsertData.started_at) {
      upsertData.started_at = new Date().toISOString();
    }

    if (recordingUri) upsertData.audio_url = recordingUri;

    if (entityId) {
      upsertData.linked_entity_type = entityType;
      upsertData.linked_entity_id = entityId;
      upsertData.linked_entity_name = entityName;
    }

    const { data: callLog, error: upsertError } = await (supabase as any)
      .from('call_logs')
      .upsert(upsertData, { onConflict: 'external_call_id' })
      .select('id, linked_entity_id, linked_entity_type')
      .maybeSingle();

    if (upsertError) {
      console.error('[rc-webhook] upsert call_log error:', upsertError);
      continue;
    }

    // Auto-create note on the linked entity
    const linkedId = entityId ?? callLog?.linked_entity_id;
    const linkedType = entityType ?? callLog?.linked_entity_type;
    if (linkedId && linkedType) {
      const durationStr = duration
        ? ` (${Math.floor(duration / 60)}m ${duration % 60}s)`
        : '';
      await (supabase as any).from('notes').insert({
        entity_id: linkedId,
        entity_type: linkedType,
        note: `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} call from RingCentral${durationStr}.${recordingUri ? ' Recording available.' : ''}`,
        created_by: null,
      });
    }
  }
}

// ---- Recording ready ----
async function handleRecordingReady(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const sessionId = (body.telephonySessionId ?? body.sessionId) as string | undefined;
  const recordingObj = (body.recording ?? body) as Record<string, unknown>;
  const contentUri = (recordingObj.contentUri ?? recordingObj.content_uri) as string | undefined;

  if (!contentUri) return;

  if (sessionId) {
    const { error } = await (supabase as any)
      .from('call_logs')
      .update({ audio_url: contentUri })
      .eq('external_call_id', sessionId);
    if (error) console.error('[rc-webhook] update audio_url error:', error);
  }
}

// ---- AI summary / notes ----
async function handleAiSummary(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const sessionId = (body.telephonySessionId ?? body.sessionId ?? body.callId) as string | undefined;
  const summary =
    (body.summary as string) ??
    ((body.highlights as string[])?.join('\n')) ??
    (body.notes as string) ??
    null;

  if (!sessionId || !summary) return;

  const { data: callLog, error } = await (supabase as any)
    .from('call_logs')
    .update({ summary })
    .eq('external_call_id', sessionId)
    .select('id, linked_entity_id, linked_entity_type')
    .maybeSingle();

  if (error) console.error('[rc-webhook] update summary error:', error);

  if (callLog?.linked_entity_id && callLog?.linked_entity_type) {
    await (supabase as any).from('notes').insert({
      entity_id: callLog.linked_entity_id,
      entity_type: callLog.linked_entity_type,
      note: `🤖 AI Call Summary: ${summary}`,
      created_by: null,
    });
  }
}

// ---- Phone number matching ----
async function matchPhone(supabase: ReturnType<typeof createClient>, phone: string | null | undefined): Promise<{
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
}> {
  if (!phone) return { entityType: null, entityId: null, entityName: null };

  const normalized = phone.replace(/[^0-9+]/g, '');
  const norm = (p: string) => p.replace(/[^0-9+]/g, '');

  const [{ data: candidates }, { data: contacts }] = await Promise.all([
    (supabase as any).from('candidates').select('id, full_name, phone').not('phone', 'is', null),
    (supabase as any).from('contacts').select('id, full_name, phone').not('phone', 'is', null),
  ]);

  const candidate = (candidates as any[])?.find((c) => c.phone && norm(c.phone) === normalized);
  if (candidate) return { entityType: 'candidate', entityId: candidate.id, entityName: candidate.full_name };

  const contact = (contacts as any[])?.find((c) => c.phone && norm(c.phone) === normalized);
  if (contact) return { entityType: 'contact', entityId: contact.id, entityName: contact.full_name };

  return { entityType: null, entityId: null, entityName: null };
}
