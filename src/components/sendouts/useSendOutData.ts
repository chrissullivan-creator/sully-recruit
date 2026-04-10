import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

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
  resume_link: string | null;
  created_at: string;
  updated_at: string;
  candidate_name: string | null;
  candidate_email: string | null;
  candidate_linkedin_url: string | null;
  candidate_avatar_url: string | null;
  job_title: string | null;
  company_name: string | null;
  contact_name: string | null;
  recruiter_name: string | null;
  recruiter_avatar_url: string | null;
}

export function useSendOutBoardRows() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['send_out_board_rows'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_out_board')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SendOutBoardRow[];
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel('send-outs-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'send_outs' },
        () => qc.invalidateQueries({ queryKey: ['send_out_board_rows'] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);

  return query;
}

export function useSendOutBoardRow(id: string | undefined) {
  return useQuery({
    queryKey: ['send_out_board_row', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_out_board')
        .select('*')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as SendOutBoardRow | null;
    },
  });
}
