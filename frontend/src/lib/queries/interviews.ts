import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Lite interview shape used by the stage strip + person/company tabs. */
export interface InterviewLite {
  id: string;
  send_out_id: string | null;
  candidate_id: string | null;
  job_id: string | null;
  round: number | null;
  stage: string | null;
  interview_type: string | null;
  scheduled_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  outcome: string | null;
  interviewer_name: string | null;
  jobs?: { id: string; title: string | null; company_name: string | null } | null;
  candidate?: { id: string; full_name: string | null } | null;
}

const LITE_COLS =
  'id, send_out_id, candidate_id, job_id, round, stage, interview_type, scheduled_at, completed_at, cancelled_at, outcome, interviewer_name';

/**
 * Every non-cancelled interview (lite columns), cached under one key so the
 * Send-Outs board can render per-card round strips from a single fetch
 * (react-query dedupes the many card subscribers into one request).
 */
export function useInterviewStages() {
  return useQuery({
    queryKey: ['interview_stages'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('interviews')
        .select(LITE_COLS)
        .is('cancelled_at', null)
        .order('round', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as InterviewLite[];
    },
    staleTime: 30_000,
  });
}

/** Interviews for one candidate (with job info), oldest round first. */
export function useCandidateInterviews(candidateId: string | null | undefined) {
  return useQuery({
    queryKey: ['interviews_candidate', candidateId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('interviews')
        .select(`${LITE_COLS}, jobs(id, title, company_name)`)
        .eq('candidate_id', candidateId as string)
        .is('cancelled_at', null)
        .order('round', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as InterviewLite[];
    },
    enabled: !!candidateId,
  });
}

/** Interviews across every job at a company — the client-side view. */
export function useCompanyInterviews(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ['interviews_company', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('interviews')
        .select(`${LITE_COLS}, jobs!inner(id, title, company_name, company_id), candidate:people!candidate_id(id, full_name)`)
        .eq('jobs.company_id', companyId as string)
        .is('cancelled_at', null)
        .order('scheduled_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as InterviewLite[];
    },
    enabled: !!companyId,
  });
}

/**
 * Filter a loaded interview set down to one send-out / candidate-job, sorted by
 * round. Prefers matching on send_out_id; falls back to candidate_id + job_id
 * (interviews created manually before a send-out exists).
 */
export function pickInterviews(
  all: InterviewLite[],
  { sendOutId, candidateId, jobId }: { sendOutId?: string | null; candidateId?: string | null; jobId?: string | null },
): InterviewLite[] {
  let rows = sendOutId ? all.filter((iv) => iv.send_out_id === sendOutId) : [];
  if (rows.length === 0 && candidateId && jobId) {
    rows = all.filter((iv) => iv.candidate_id === candidateId && iv.job_id === jobId);
  }
  return rows.slice().sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
}

/** Human status for a round: where it sits in the schedule/complete lifecycle. */
export type RoundStatus = 'completed' | 'scheduled' | 'to_schedule';
export function roundStatus(iv: InterviewLite): RoundStatus {
  if (iv.completed_at) return 'completed';
  if (iv.scheduled_at) return 'scheduled';
  return 'to_schedule';
}
