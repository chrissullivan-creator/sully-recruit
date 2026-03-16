import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type InboundChannel = 'email' | 'sms' | 'linkedin_inmail' | 'linkedin_message';
export type InboundProvider = 'microsoft' | 'ringcentral' | 'unipile';

export interface HandleInboundReplyInput {
  provider: InboundProvider;
  channel: InboundChannel;
  externalMessageId: string;
  externalThreadId?: string | null;
  fromIdentity?: string | null;
  toIdentity?: string | null;
  subject?: string | null;
  body?: string | null;
  sentAt?: string | null;
  rawPayload: Record<string, unknown>;
  ownerId?: string | null;
  reason?: string;
}

export interface HandleInboundReplyResult {
  deduped: boolean;
  messageId?: string;
  candidateId?: string | null;
  contactId?: string | null;
  stoppedEnrollments?: number;
}

function normalizeEmail(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizePhone(value?: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/[^\d+]/g, '');
  return digits.length > 0 ? digits : null;
}

async function findByIdentity(
  supabase: SupabaseClient,
  channel: InboundChannel,
  identity?: string | null,
): Promise<{ candidateId: string | null; contactId: string | null } | null> {
  if (!identity) return null;

  if (channel === 'email') {
    const email = normalizeEmail(identity);
    if (!email) return null;

    const { data: candidate } = await supabase
      .from('candidates')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    if (candidate?.id) return { candidateId: candidate.id, contactId: null };

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    if (contact?.id) return { candidateId: null, contactId: contact.id };
  }

  if (channel === 'sms') {
    const phone = normalizePhone(identity);
    if (!phone) return null;

    const { data: candidate } = await supabase
      .from('candidates')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();
    if (candidate?.id) return { candidateId: candidate.id, contactId: null };

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();
    if (contact?.id) return { candidateId: null, contactId: contact.id };
  }

  if (channel === 'linkedin_inmail' || channel === 'linkedin_message') {
    const linkedinId = identity.trim();

    const { data: candidateChannel } = await supabase
      .from('candidate_channels')
      .select('candidate_id')
      .eq('provider_id', linkedinId)
      .limit(1)
      .maybeSingle();
    if (candidateChannel?.candidate_id) return { candidateId: candidateChannel.candidate_id, contactId: null };

    const { data: contactChannel } = await supabase
      .from('contact_channels')
      .select('contact_id')
      .eq('provider_id', linkedinId)
      .limit(1)
      .maybeSingle();
    if (contactChannel?.contact_id) return { candidateId: null, contactId: contactChannel.contact_id };
  }

  return null;
}

async function findByThread(
  supabase: SupabaseClient,
  provider: InboundProvider,
  externalThreadId?: string | null,
): Promise<{ candidateId: string | null; contactId: string | null } | null> {
  if (!externalThreadId) return null;

  const { data: existing } = await supabase
    .from('messages')
    .select('candidate_id, contact_id')
    .eq('provider', provider)
    .eq('external_thread_id', externalThreadId)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!existing?.candidate_id && !existing?.contact_id) return null;
  return {
    candidateId: existing.candidate_id ?? null,
    contactId: existing.contact_id ?? null,
  };
}

async function createFollowUpTask(
  supabase: SupabaseClient,
  input: HandleInboundReplyInput,
  messageId: string,
  candidateId: string | null,
  contactId: string | null,
) {
  const ownerField = candidateId ? 'candidates' : contactId ? 'contacts' : null;
  const ownerEntityId = candidateId ?? contactId;

  let ownerId = input.ownerId ?? null;
  if (!ownerId && ownerField && ownerEntityId) {
    const { data: ownerData } = await supabase
      .from(ownerField)
      .select('owner_id')
      .eq('id', ownerEntityId)
      .maybeSingle();
    ownerId = (ownerData as any)?.owner_id ?? null;
  }

  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .insert({
      title: `Inbound ${input.channel} reply needs follow-up`,
      description: `A contact replied on ${input.channel}. Review and respond.`,
      status: 'pending',
      priority: 'high',
      created_by: ownerId,
      assigned_to: ownerId,
    })
    .select('id')
    .single();

  if (taskError || !task?.id) {
    console.error('Failed creating follow-up task', taskError);
    return;
  }

  await supabase
    .from('task_links')
    .insert([
      { task_id: task.id, entity_type: 'message', entity_id: messageId },
      ...(candidateId ? [{ task_id: task.id, entity_type: 'candidate', entity_id: candidateId }] : []),
      ...(contactId ? [{ task_id: task.id, entity_type: 'contact', entity_id: contactId }] : []),
    ]);
}

async function enqueueAiSummaryJob(
  supabase: SupabaseClient,
  input: HandleInboundReplyInput,
  messageId: string,
  candidateId: string | null,
  contactId: string | null,
) {
  await supabase.from('webhook_events').insert({
    provider: 'system',
    event_type: 'ai_inbound_summary_requested',
    payload: {
      message_id: messageId,
      candidate_id: candidateId,
      contact_id: contactId,
      provider: input.provider,
      channel: input.channel,
    },
    received_at: new Date().toISOString(),
    processed: false,
  });
}

export async function handleInboundReply(
  supabase: SupabaseClient,
  input: HandleInboundReplyInput,
): Promise<HandleInboundReplyResult> {
  const nowIso = input.sentAt ?? new Date().toISOString();

  const { data: duplicate } = await supabase
    .from('messages')
    .select('id, candidate_id, contact_id')
    .eq('provider', input.provider)
    .eq('external_message_id', input.externalMessageId)
    .eq('direction', 'inbound')
    .maybeSingle();

  if (duplicate?.id) {
    return {
      deduped: true,
      messageId: duplicate.id,
      candidateId: duplicate.candidate_id,
      contactId: duplicate.contact_id,
      stoppedEnrollments: 0,
    };
  }

  let matched = await findByThread(supabase, input.provider, input.externalThreadId);
  if (!matched) {
    matched = await findByIdentity(supabase, input.channel, input.fromIdentity);
  }

  const candidateId = matched?.candidateId ?? null;
  const contactId = matched?.contactId ?? null;

  const { data: inserted, error: insertError } = await supabase
    .from('messages')
    .insert({
      candidate_id: candidateId,
      contact_id: contactId,
      channel: input.channel,
      provider: input.provider,
      direction: 'inbound',
      external_message_id: input.externalMessageId,
      external_thread_id: input.externalThreadId ?? null,
      from_identity: input.fromIdentity ?? null,
      to_identity: input.toIdentity ?? null,
      sent_at: nowIso,
      body: input.body ?? '',
      raw_payload: input.rawPayload,
    })
    .select('id')
    .single();

  if (insertError || !inserted?.id) {
    // if unique race happened, treat as deduped
    if ((insertError as any)?.code === '23505') {
      return { deduped: true };
    }
    throw insertError;
  }

  const { data: stopResult, error: stopError } = await supabase.rpc('stop_active_sequences_for_person', {
    p_candidate_id: candidateId,
    p_contact_id: contactId,
    p_channel: input.channel,
    p_message_id: inserted.id,
    p_reason: input.reason ?? 'inbound_reply',
  });

  if (stopError) {
    console.error('Failed to stop active sequences', stopError);
  }

  await createFollowUpTask(supabase, input, inserted.id, candidateId, contactId);
  await enqueueAiSummaryJob(supabase, input, inserted.id, candidateId, contactId);

  return {
    deduped: false,
    messageId: inserted.id,
    candidateId,
    contactId,
    stoppedEnrollments: typeof stopResult === 'number' ? stopResult : 0,
  };
}
