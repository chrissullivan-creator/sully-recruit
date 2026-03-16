import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type TrackedInboundChannel = 'email' | 'sms' | 'linkedin_recruiter' | 'linkedin_message';

type InboundMessageInput = {
  provider: 'outlook' | 'ringcentral' | 'unipile';
  channel: TrackedInboundChannel;
  body: string;
  subject?: string | null;
  senderAddress?: string | null;
  recipientAddress?: string | null;
  senderName?: string | null;
  externalMessageId?: string | null;
  externalConversationId?: string | null;
  occurredAt?: string | null;
  rawPayload?: Record<string, unknown>;
  createFollowUpTask?: boolean;
  aiNotesEnabled?: boolean;
};

type MatchResult = {
  candidate_id: string | null;
  contact_id: string | null;
};

export function getServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

export async function processInboundReply(input: InboundMessageInput) {
  const supabase = getServiceClient();

  const match = await matchEntity(supabase, input);
  if (!match.candidate_id && !match.contact_id) {
    throw new Error('Unable to match inbound message to candidate/contact');
  }

  const conversationId = await getOrCreateConversation(supabase, input.channel, match, input.externalConversationId);

  const { data: insertedMessage, error: insertError } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      candidate_id: match.candidate_id,
      contact_id: match.contact_id,
      channel: input.channel,
      direction: 'inbound',
      subject: input.subject ?? null,
      body: input.body,
      sender_name: input.senderName ?? null,
      sender_address: input.senderAddress ?? null,
      recipient_address: input.recipientAddress ?? null,
      received_at: input.occurredAt ?? new Date().toISOString(),
      external_message_id: input.externalMessageId ?? null,
      external_conversation_id: input.externalConversationId ?? null,
      provider: input.provider,
      raw_payload: input.rawPayload ?? null,
      sent_at: input.occurredAt ?? new Date().toISOString(),
    })
    .select('id')
    .single();

  if (insertError) throw insertError;

  const stopped = await stopActiveEnrollmentsForReply(supabase, {
    ...match,
    channel: input.channel,
    message_id: insertedMessage.id,
    reason: 'candidate_replied',
    provider: input.provider,
  });

  let taskId: string | null = null;
  if (input.createFollowUpTask) {
    taskId = await createOptionalFollowUpTask(supabase, match, input.channel, input.body);
  }

  if (input.aiNotesEnabled) {
    await createAiSummaryNote(supabase, match, input.channel, input.body);
  }

  return {
    message_id: insertedMessage.id,
    matched: match,
    stopped_enrollments: stopped,
    follow_up_task_id: taskId,
  };
}

async function matchEntity(supabase: any, input: InboundMessageInput): Promise<MatchResult> {
  const byConversation = await findByExternalConversationId(supabase, input.externalConversationId);
  if (byConversation) return byConversation;

  if (input.senderAddress) {
    if (input.channel === 'email') {
      const email = input.senderAddress.toLowerCase().trim();
      const [candidateRes, contactRes] = await Promise.all([
        supabase.from('candidates').select('id').ilike('email', email).limit(1).maybeSingle(),
        supabase.from('contacts').select('id').ilike('email', email).limit(1).maybeSingle(),
      ]);
      return {
        candidate_id: candidateRes.data?.id ?? null,
        contact_id: contactRes.data?.id ?? null,
      };
    }

    if (input.channel === 'sms') {
      const normalized = normalizePhone(input.senderAddress);
      const [candidateRes, contactRes] = await Promise.all([
        supabase.from('candidates').select('id, phone').limit(200),
        supabase.from('contacts').select('id, phone').limit(200),
      ]);

      const candidate = (candidateRes.data || []).find((c: any) => normalizePhone(c.phone) === normalized);
      const contact = (contactRes.data || []).find((c: any) => normalizePhone(c.phone) === normalized);
      return { candidate_id: candidate?.id ?? null, contact_id: contact?.id ?? null };
    }
  }

  return { candidate_id: null, contact_id: null };
}

async function findByExternalConversationId(supabase: any, externalConversationId?: string | null): Promise<MatchResult | null> {
  if (!externalConversationId) return null;

  const [candChannel, contactChannel] = await Promise.all([
    supabase
      .from('candidate_channels')
      .select('candidate_id')
      .eq('external_conversation_id', externalConversationId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('contact_channels')
      .select('contact_id')
      .eq('external_conversation_id', externalConversationId)
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    candidate_id: candChannel.data?.candidate_id ?? null,
    contact_id: contactChannel.data?.contact_id ?? null,
  };
}

async function getOrCreateConversation(supabase: any, channel: string, match: MatchResult, externalConversationId?: string | null) {
  let query = supabase
    .from('conversations')
    .select('id')
    .eq('channel', channel)
    .limit(1);

  if (match.candidate_id) {
    query = query.eq('candidate_id', match.candidate_id);
  } else if (match.contact_id) {
    query = query.eq('contact_id', match.contact_id);
  }

  if (externalConversationId) {
    query = query.eq('external_conversation_id', externalConversationId);
  }

  const { data: existing } = await query.maybeSingle();
  if (existing?.id) return existing.id;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      candidate_id: match.candidate_id,
      contact_id: match.contact_id,
      channel,
      external_conversation_id: externalConversationId ?? null,
      status: 'active',
      last_message_at: new Date().toISOString(),
      last_message_preview: null,
      is_read: false,
    })
    .select('id')
    .single();

  if (error || !created?.id) throw error ?? new Error('Failed to create conversation');
  return created.id;
}

async function stopActiveEnrollmentsForReply(
  supabase: any,
  opts: { candidate_id: string | null; contact_id: string | null; channel: string; message_id: string; reason: string; provider: string }
): Promise<number> {
  let query = supabase
    .from('sequence_enrollments')
    .update({
      status: 'stopped',
      stopped_reason: opts.reason,
      stopped_at: new Date().toISOString(),
      stop_channel: opts.channel,
      stop_message_id: opts.message_id,
      stop_context: {
        provider: opts.provider,
        message_id: opts.message_id,
        source: 'inbound_reply',
      },
    })
    .eq('status', 'active')
    .select('id');

  if (opts.candidate_id) {
    query = query.eq('candidate_id', opts.candidate_id);
  } else if (opts.contact_id) {
    query = query.eq('contact_id', opts.contact_id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data?.length ?? 0;
}

async function createOptionalFollowUpTask(supabase: any, match: MatchResult, channel: string, body: string): Promise<string | null> {
  const entityId = match.candidate_id ?? match.contact_id;
  const entityType = match.candidate_id ? 'candidate' : 'contact';
  if (!entityId) return null;

  const { data: task, error } = await supabase
    .from('tasks')
    .insert({
      title: `Inbound reply received (${channel})`,
      description: `Respond to inbound ${channel} message: "${body.slice(0, 500)}"`,
      priority: 'high',
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !task?.id) return null;

  await supabase.from('task_links').insert({
    task_id: task.id,
    entity_type: entityType,
    entity_id: entityId,
  });

  return task.id;
}

async function createAiSummaryNote(supabase: any, match: MatchResult, channel: string, body: string) {
  const entityId = match.candidate_id ?? match.contact_id;
  const entityType = match.candidate_id ? 'candidate' : 'contact';
  if (!entityId) return;

  const summary = `Inbound ${channel} reply: ${body.slice(0, 1000)}`;

  await supabase.from('notes').insert({
    entity_id: entityId,
    entity_type: entityType,
    content: summary,
  });
}

function normalizePhone(input?: string | null): string {
  if (!input) return '';
  return input.replace(/[^0-9+]/g, '').replace(/^00/, '+');
}
