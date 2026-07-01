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
 * value. Non-interview stages pass through unchanged. Round info now
 * lives on a separate `interview_round` integer (May 2026 simplification).
 *
 * Previously this returned 'interview' regardless of input — every
 * caller that piped a stage value through here ended up writing
 * `stage='interview'` to send_outs no matter which chip the user
 * actually clicked. Three pages had this bug; fixing it here repairs
 * all of them.
 */
export function normalizeInterviewStage(stage: string | null | undefined): string {
  const v = String(stage || '').toLowerCase();
  if (INTERVIEW_STAGE_VALUES.has(v)) return 'interview';
  return v;
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

  // interviews.stage is the per-interview lifecycle (to_be_scheduled |
  // scheduled | interview_debrief), NOT the canonical funnel stage.
  const lifecycleStage = interviewAt ? 'scheduled' : 'to_be_scheduled';

  // Idempotency: a stage move must create AT MOST one interview per
  // (candidate, job). If ANY interview already exists for this pair (round 1
  // from a prior move, or round 2+ added via createInterview), we update the
  // latest round's scheduled_at and stop — we never mint a second row. Extra
  // rounds are created explicitly through `createInterview`, not here.
  if (candidateId && jobId) {
    const { data: existing } = await supabase
      .from('interviews')
      .select('id, scheduled_at')
      .eq('candidate_id', candidateId)
      .eq('job_id', jobId)
      .order('round', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      if (interviewAt && !existing.scheduled_at) {
        await supabase.from('interviews')
          .update({ scheduled_at: interviewAt, stage: 'scheduled' })
          .eq('id', existing.id);
      }
      return;
    }

    // No interview yet → create round 1. ignoreDuplicates makes a concurrent
    // stage move a no-op instead of a duplicate (backed by the
    // uniq_interviews_candidate_job_round index).
    await supabase.from('interviews').upsert(
      {
        send_out_id: payload.sendOutId,
        candidate_id: candidateId,
        interviewer_contact_id: contactId,
        job_id: jobId,
        owner_id: ownerId,
        stage: lifecycleStage,
        round: 1,
        scheduled_at: interviewAt,
      },
      { onConflict: 'candidate_id,job_id,round', ignoreDuplicates: true },
    );
    return;
  }

  // Fallback for interviews without a resolvable candidate+job (rare): keep the
  // legacy send_out-scoped select-then-insert on round 1.
  const { data: existing } = await supabase
    .from('interviews')
    .select('id, scheduled_at')
    .eq('send_out_id', payload.sendOutId)
    .eq('round', 1)
    .maybeSingle();

  if (existing) {
    if (interviewAt && !existing.scheduled_at) {
      await supabase.from('interviews')
        .update({ scheduled_at: interviewAt, stage: 'scheduled' })
        .eq('id', existing.id);
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
    round: 1,
    scheduled_at: interviewAt,
  });
}
