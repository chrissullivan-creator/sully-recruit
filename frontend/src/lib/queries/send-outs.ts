import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Shape of a row used by the SendOuts page. Joined to candidate + job + recruiter.
export interface SendOutRow {
  id: string;
  candidate_id: string | null;
  job_id: string | null;
  recruiter_id: string | null;
  stage: string;
  outcome: string | null;
  sent_to_client_at: string | null;
  interview_at: string | null;
  offer_at: string | null;
  placed_at: string | null;
  created_at: string;
  updated_at: string | null;
  submittal_notes: string | null;
  resume_url: string | null;
  candidate: {
    id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    current_title: string | null;
    current_company: string | null;
    target_total_comp: number | null;
    target_base_comp: number | null;
    avatar_url: string | null;
    last_contacted_at: string | null;
    owner_user_id: string | null;
    type: string | null;
  } | null;
  job: {
    id: string;
    title: string | null;
    company_name: string | null;
  } | null;
}

export function useSendOuts() {
  return useQuery({
    queryKey: ['send_outs_list'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_outs')
        .select(`
          id, candidate_id, job_id, recruiter_id, stage, outcome,
          sent_to_client_at, interview_at, offer_at, placed_at,
          created_at, updated_at, submittal_notes, resume_url,
          candidate:people!candidate_id(id, full_name, first_name, last_name, current_title, current_company, target_total_comp, target_base_comp, avatar_url, last_contacted_at, owner_user_id, type),
          job:jobs(id, title, company_name)
        `)
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as SendOutRow[];
    },
  });
}

/** Format a comp value as a $XXk string. Returns "—" when null/zero. */
export function formatComp(amt: number | null | undefined): string {
  if (!amt || amt <= 0) return '—';
  if (amt >= 1_000_000) return `$${(amt / 1_000_000).toFixed(1)}M`;
  if (amt >= 1_000) return `$${Math.round(amt / 1_000)}k`;
  return `$${amt.toLocaleString()}`;
}

/** Last-touch timestamp for a row — most recent of stage-specific timestamps + updated_at. */
export function lastTouchAt(row: SendOutRow): string | null {
  const candidates = [
    row.placed_at, row.offer_at, row.interview_at, row.sent_to_client_at,
    row.candidate?.last_contacted_at ?? null, row.updated_at,
  ].filter(Boolean) as string[];
  if (candidates.length === 0) return null;
  return candidates.sort().reverse()[0];
}
