import { supabase } from '@/integrations/supabase/client';

const INTERVIEW_STAGE_VALUES = new Set([
  'interview', 'interviewing',
  // Legacy values still tolerated when reading old data; new writes
  // always use 'interview' with a separate interview_round integer.
  'interview_round_1', 'interview_round_2_plus',
]);

export function isInterviewStage(stage: string | null | undefined) {
  return INTERVIEW_STAGE_VALUES.has(String(stage || '').toLowerCase());
}

/**
 * Normalise any interview-stage variant to the canonical 'interview'
 * value. Round info should be passed separately via interview_round
 * since May 2026.
 */
export function normalizeInterviewStage(_stage: string | null | undefined) {
  return 'interview';
}

/**
 * When a send-out moves to an interview stage we record an `interviews` row
 * (the canonical funnel event) — NOT a tasks row. Per direction "interviews
 * just be interviews"; they shouldn't show up under To-Do's. The interviews
 * table has its own dedicated UI surfaces (Job Detail Pipeline, dashboard
 * funnel, etc.).
 *
 * Idempotent on (send_out_id, round): later moves update the existing row's
 * scheduled_at if the caller passes one, otherwise leave it alone.
 */
export async function ensureInterviewArtifacts(payload: {
  sendOutId: string;
  candidateId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  recruiterId?: string | null;
  stage: string;
  interviewAt?: string | null;
}) {
  if (!isInterviewStage(payload.stage)) return;

  const stage = normalizeInterviewStage(payload.stage);
  // Default to round 1; callers wanting a specific round should pass it
  // through and write to send_outs.interview_round directly.
  const round = 1;

  // Pull canonical IDs from the send_out so the interview row can stand alone.
  const [{ data: sendOut }, { data: actor }] = await Promise.all([
    supabase
      .from('send_outs')
      .select('id, candidate_id, contact_id, job_id, recruiter_id, interview_at')
      .eq('id', payload.sendOutId)
      .maybeSingle(),
    supabase.auth.getUser(),
  ]);

  const candidateId = payload.candidateId ?? sendOut?.candidate_id ?? null;
  const contactId   = payload.contactId   ?? sendOut?.contact_id   ?? null;
  const jobId       = payload.jobId       ?? sendOut?.job_id       ?? null;
  const ownerId     = payload.recruiterId ?? sendOut?.recruiter_id ?? actor.user?.id ?? null;
  const interviewAt = payload.interviewAt ?? sendOut?.interview_at ?? null;

  // Upsert an interviews row for this (send_out, round). We don't have a
  // dedicated unique index, so do select-then-insert/update by hand.
  const { data: existing } = await supabase
    .from('interviews')
    .select('id, scheduled_at, stage')
    .eq('send_out_id', payload.sendOutId)
    .eq('round', round)
    .maybeSingle();

  // interviews.stage is the per-interview lifecycle (to_be_scheduled |
  // scheduled | interview_debrief), NOT the canonical funnel stage.
  const lifecycleStage = interviewAt ? 'scheduled' : 'to_be_scheduled';

  if (existing) {
    const patch: Record<string, any> = {};
    if (interviewAt && !existing.scheduled_at) {
      patch.scheduled_at = interviewAt;
      patch.stage = 'scheduled';
    }
    if (Object.keys(patch).length > 0) {
      await supabase.from('interviews').update(patch).eq('id', existing.id);
    }
    return;
  }

  await supabase.from('interviews').insert({
    send_out_id: payload.sendOutId,
    candidate_id: candidateId,
    interviewer_contact_id: contactId,
    job_id: jobId,
    owner_id: ownerId,
    stage: lifecycleStage,
    round,
    scheduled_at: interviewAt,
  });
}
