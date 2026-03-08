import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

// Candidates
export function useCandidates() {
  return useQuery({
    queryKey: ['candidates'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Jobs with company info
export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('jobs')
        .select('*, companies(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Companies with job counts
export function useCompanies() {
  return useQuery({
    queryKey: ['companies'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('companies')
        .select('*, jobs(id)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data.map((c) => ({
        ...c,
        job_count: c.jobs?.length ?? 0,
      }));
    },
  });
}

// Contacts with company
export function useContacts() {
  return useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*, companies(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Prospects (Leads page)
export function useProspects() {
  return useQuery({
    queryKey: ['prospects'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('prospects')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Sequences (Campaigns page)
export function useSequences() {
  return useQuery({
    queryKey: ['sequences'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sequences')
        .select('*, sequence_steps(*), sequence_enrollments(id)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Send out board view
export function useSendOutBoard() {
  return useQuery({
    queryKey: ['send_out_board'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_out_board')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Dashboard metrics (aggregated counts)
export function useDashboardMetrics() {
  return useQuery({
    queryKey: ['dashboard_metrics'],
    queryFn: async () => {
      const [jobsRes, candidatesRes, sendOutsRes, prospectsRes] = await Promise.all([
        supabase.from('jobs').select('id, status', { count: 'exact' }).eq('status', 'open'),
        supabase.from('candidates').select('id, status', { count: 'exact' }).eq('status', 'active'),
        supabase.from('send_outs').select('id, stage'),
        supabase.from('prospects').select('id', { count: 'exact' }),
      ]);

      const sendOuts = sendOutsRes.data ?? [];
      const interviews = sendOuts.filter((s) => s.stage === 'interview').length;
      const offers = sendOuts.filter((s) => s.stage === 'offer').length;

      return {
        activeJobs: jobsRes.count ?? 0,
        activeCandidates: candidatesRes.count ?? 0,
        interviewsThisWeek: interviews,
        offersOut: offers,
        leadsToFollow: prospectsRes.count ?? 0,
        callsToday: 0,
        emailsSent: 0,
        responseRate: 0,
      };
    },
  });
}
