import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useProfiles, type Profile } from '@/hooks/useProfiles';

export interface SendOutBoardRow {
  id: string;
  candidate_id: string | null;
  contact_id: string | null;
  job_id: string | null;
  recruiter_id: string | null;
  stage: string;
  outcome: string | null;
  sent_to_client_at: string | null;
  interview_at: string | null;
  offer_at: string | null;
  placed_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  feedback: string | null;
  submittal_notes: string | null;
  resume_url: string | null;
  resume_file_name: string | null;
  created_at: string;
  updated_at: string;

  // Joined / derived fields
  candidate_name: string | null;
  candidate_email: string | null;
  candidate_avatar_url: string | null;
  candidate_linkedin_url: string | null;
  job_title: string | null;
  company_name: string | null;
  contact_name: string | null;
  recruiter_name: string | null;
  recruiter_avatar_url: string | null;
}

const SELECT_WITH_JOINS = `
  *,
  candidates!send_outs_candidate_id_fkey ( full_name, email, avatar_url, linkedin_url ),
  jobs!send_outs_job_id_fkey ( title, companies ( name ) ),
  contacts!send_outs_contact_id_fkey ( full_name )
`.trim();

function mergeRow(raw: any, profilesById: Record<string, Profile>): SendOutBoardRow {
  const c = raw.candidates ?? {};
  const j = raw.jobs ?? {};
  const co = j.companies ?? {};
  const ct = raw.contacts ?? {};
  const recruiter = raw.recruiter_id ? profilesById[raw.recruiter_id] : null;
  return {
    id: raw.id,
    candidate_id: raw.candidate_id ?? null,
    contact_id: raw.contact_id ?? null,
    job_id: raw.job_id ?? null,
    recruiter_id: raw.recruiter_id ?? null,
    stage: raw.stage,
    outcome: raw.outcome ?? null,
    sent_to_client_at: raw.sent_to_client_at ?? null,
    interview_at: raw.interview_at ?? null,
    offer_at: raw.offer_at ?? null,
    placed_at: raw.placed_at ?? null,
    rejected_by: raw.rejected_by ?? null,
    rejection_reason: raw.rejection_reason ?? null,
    feedback: raw.feedback ?? null,
    submittal_notes: raw.submittal_notes ?? null,
    resume_url: raw.resume_url ?? null,
    resume_file_name: raw.resume_file_name ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    candidate_name: c.full_name ?? null,
    candidate_email: c.email ?? null,
    candidate_avatar_url: c.avatar_url ?? null,
    candidate_linkedin_url: c.linkedin_url ?? null,
    job_title: j.title ?? null,
    company_name: co.name ?? null,
    contact_name: ct.full_name ?? null,
    recruiter_name: recruiter?.full_name ?? null,
    recruiter_avatar_url: recruiter?.avatar_url ?? null,
  };
}

export function useSendOutBoardRows() {
  const qc = useQueryClient();
  const { data: profiles = [] } = useProfiles();
  const profilesById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p])),
    [profiles],
  );

  const query = useQuery({
    queryKey: ['send_out_rows'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_outs')
        .select(SELECT_WITH_JOINS)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as any[];
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel('send-outs-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'send_outs' },
        () => qc.invalidateQueries({ queryKey: ['send_out_rows'] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  const rows = useMemo<SendOutBoardRow[]>(
    () => (query.data ?? []).map((r) => mergeRow(r, profilesById)),
    [query.data, profilesById],
  );

  return { data: rows, isLoading: query.isLoading, error: query.error };
}

export function useSendOutBoardRow(id: string | undefined) {
  const { data: profiles = [] } = useProfiles();
  const profilesById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p])),
    [profiles],
  );

  const query = useQuery({
    queryKey: ['send_out_row', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_outs')
        .select(SELECT_WITH_JOINS)
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as any;
    },
  });

  const row = useMemo<SendOutBoardRow | null>(
    () => (query.data ? mergeRow(query.data, profilesById) : null),
    [query.data, profilesById],
  );

  return { data: row, isLoading: query.isLoading, error: query.error };
}
