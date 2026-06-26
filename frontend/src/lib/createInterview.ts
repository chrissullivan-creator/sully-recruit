import { supabase } from '@/integrations/supabase/client';

/**
 * Create a fresh interview record for a candidate on a job — its own date,
 * interviewers, notes, and debrief. Round auto-increments per candidate+job, so
 * calling this again makes round 2, 3, … Returns the new interview id.
 */
export async function createInterview(opts: {
  candidateId: string;
  jobId: string;
  sendOutId?: string | null;
  ownerId?: string | null;
}): Promise<string> {
  const { data: maxRow } = await supabase
    .from('interviews')
    .select('round')
    .eq('candidate_id', opts.candidateId)
    .eq('job_id', opts.jobId)
    .order('round', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextRound = (Number((maxRow as any)?.round) || 0) + 1;
  const ownerId = opts.ownerId ?? (await supabase.auth.getUser()).data.user?.id ?? null;

  const { data, error } = await supabase
    .from('interviews')
    .insert({
      candidate_id: opts.candidateId,
      job_id: opts.jobId,
      send_out_id: opts.sendOutId ?? null,
      owner_id: ownerId,
      round: nextRound,
      stage: 'to_be_scheduled',
    } as any)
    .select('id')
    .single();
  if (error) throw error;
  return (data as any).id;
}
