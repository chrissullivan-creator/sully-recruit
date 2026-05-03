import { supabase } from '@/integrations/supabase/client';
import type { CanonicalStage } from '@/lib/pipeline';

export interface MoveStageInput {
  /** The send_out row's id. Required — we update it directly. */
  sendOutId: string;
  /** Optional candidate_job row id. If present, candidate_jobs.pipeline_stage is also updated. */
  candidateJobId?: string | null;
  fromStage: string | null;
  toStage: CanonicalStage;
  /** 'manual' | 'drag' | 'advance' | 'drawer' — passed straight through to stage_transitions.trigger_source. */
  triggerSource?: string;
  /** When known, the candidate_jobs.candidate_id — used as entity_id in stage_transitions. */
  entityId?: string | null;
  entityType?: 'candidate_job' | 'send_out';
}

/**
 * Atomic-ish stage move. Writes to:
 *   1. send_outs.stage
 *   2. candidate_jobs.pipeline_stage (when candidateJobId is provided)
 *   3. stage_transitions log row
 *
 * Postgres doesn't expose true cross-row transactions through PostgREST, so we
 * issue the three writes sequentially. If any of the first two fail we return
 * the error so callers can roll back the optimistic UI. The log write is a
 * best-effort tail call — failing to log shouldn't break the move.
 */
export async function moveStage(input: MoveStageInput): Promise<{ ok: boolean; error?: string }> {
  const { sendOutId, candidateJobId, fromStage, toStage, triggerSource = 'manual', entityId, entityType = 'send_out' } = input;

  const stageSpecificPatch: Record<string, string> = {};
  if (toStage === 'submitted')              stageSpecificPatch.sent_to_client_at = new Date().toISOString();
  else if (toStage === 'interview_round_1') stageSpecificPatch.interview_at      = new Date().toISOString();
  else if (toStage === 'offer')             stageSpecificPatch.offer_at          = new Date().toISOString();
  else if (toStage === 'placed')            stageSpecificPatch.placed_at         = new Date().toISOString();

  const { error: soErr } = await supabase
    .from('send_outs')
    .update({ stage: toStage, ...stageSpecificPatch })
    .eq('id', sendOutId);
  if (soErr) return { ok: false, error: soErr.message };

  if (candidateJobId) {
    const { error: cjErr } = await supabase
      .from('candidate_jobs')
      .update({ pipeline_stage: toStage, stage_updated_at: new Date().toISOString() })
      .eq('id', candidateJobId);
    if (cjErr) return { ok: false, error: cjErr.message };
  }

  // Best-effort log — never blocks the move. Picks up the current user as actor
  // when the session has one.
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('stage_transitions').insert({
      entity_type: entityType,
      entity_id: entityId ?? sendOutId,
      from_stage: fromStage,
      to_stage: toStage,
      moved_by: user?.id ?? null,
      trigger_source: triggerSource,
      triggered_by_user_id: user?.id ?? null,
    });
  } catch {
    // Ignore — logging is non-critical.
  }

  return { ok: true };
}
