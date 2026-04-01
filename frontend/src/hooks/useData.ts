import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Candidates
export function useCandidates() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['candidates'],
    queryFn: async () => {
      // Supabase defaults to 1000 rows — fetch up to 5000 in batches
      const pageSize = 1000;
      let allData: any[] = [];
      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from('candidates')
          .select('*')
          .order('created_at', { ascending: false })
          .range(page * pageSize, (page + 1) * pageSize - 1);
        if (error) throw error;
        allData = allData.concat(data || []);
        hasMore = (data?.length ?? 0) === pageSize;
        page++;
        if (page > 4) break; // Safety: max 5000 records
      }
      return allData;
    },
  });

  const candidatesChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  useEffect(() => {
    // Clean up any previous channel ref
    if (candidatesChannelRef.current) {
      try { supabase.removeChannel(candidatesChannelRef.current); } catch {}
      candidatesChannelRef.current = null;
    }
    // Also remove by name in case of orphaned channels
    try {
      const existing = supabase.getChannels().find(ch => ch.topic === 'realtime:candidates-changes');
      if (existing) supabase.removeChannel(existing);
    } catch {}

    try {
      const channel = supabase
        .channel('candidates-changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'candidates' },
          () => { queryClient.invalidateQueries({ queryKey: ['candidates'] }); }
        )
        .subscribe();
      candidatesChannelRef.current = channel;

      return () => {
        try { supabase.removeChannel(channel); } catch {}
        candidatesChannelRef.current = null;
      };
    } catch (err) {
      console.warn('Failed to set up candidates realtime channel:', err);
      return () => {};
    }
  }, [queryClient]);

  return query;
}

// Single candidate by ID
export function useCandidate(id: string | undefined) {
  return useQuery({
    queryKey: ['candidate', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select('*')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

// Notes for an entity
export function useNotes(entityId: string | undefined, entityType: string) {
  return useQuery({
    queryKey: ['notes', entityType, entityId],
    enabled: !!entityId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notes')
        .select('*')
        .eq('entity_id', entityId!)
        .eq('entity_type', entityType)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Conversations & messages for a candidate
export function useCandidateConversations(candidateId: string | undefined) {
  return useQuery({
    queryKey: ['conversations', candidateId],
    enabled: !!candidateId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select('*, messages(*)')
        .eq('candidate_id', candidateId!)
        .order('last_message_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Send outs for a candidate
export function useCandidateSendOuts(candidateId: string | undefined) {
  return useQuery({
    queryKey: ['send_outs', candidateId],
    enabled: !!candidateId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_out_board')
        .select('*')
        .eq('candidate_id', candidateId!);
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

// Single job by ID
export function useJob(id: string | undefined) {
  return useQuery({
    queryKey: ['job', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('jobs')
        .select('*, companies(name)')
        .eq('id', id!)
        .maybeSingle();
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
  const queryClient = useQueryClient();

  const query = useQuery({
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

  const contactsChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  useEffect(() => {
    if (contactsChannelRef.current) {
      try { supabase.removeChannel(contactsChannelRef.current); } catch {}
      contactsChannelRef.current = null;
    }
    try {
      const existing = supabase.getChannels().find(ch => ch.topic === 'realtime:contacts-changes');
      if (existing) supabase.removeChannel(existing);
    } catch {}

    try {
      const channel = supabase
        .channel('contacts-changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'contacts' },
          () => { queryClient.invalidateQueries({ queryKey: ['contacts'] }); }
        )
        .subscribe();
      contactsChannelRef.current = channel;

      return () => {
        try { supabase.removeChannel(channel); } catch {}
        contactsChannelRef.current = null;
      };
    } catch (err) {
      console.warn('Failed to set up contacts realtime channel:', err);
      return () => {};
    }
  }, [queryClient]);

  return query;
}

// Sequences (Campaigns page)
export function useSequences() {
  return useQuery({
    queryKey: ['sequences'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sequences')
        .select('*, sequence_steps(*), sequence_enrollments(id), jobs(id, title, company_name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Send outs for a specific job
export function useJobSendOuts(jobId: string | undefined) {
  return useQuery({
    queryKey: ['send_outs_job', jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('send_out_board')
        .select('*')
        .eq('job_id', jobId!)
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


// Messages (for Calls page - filter call type messages)
export function useMessages(channel?: string) {
  return useQuery({
    queryKey: ['messages', channel],
    queryFn: async () => {
      let query = supabase
        .from('messages')
        .select('*, candidates(full_name)')
        .order('created_at', { ascending: false })
        .limit(100);
      if (channel) {
        query = query.eq('channel', channel);
      }
      const { data, error } = await query;
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
      const [jobsRes, candidatesRes, sendOutsRes] = await Promise.all([
        supabase.from('jobs').select('id, status', { count: 'exact' }).in('status', ['lead', 'hot', 'offer_made']),
        supabase.from('candidates').select('id, job_status'),
        supabase.from('send_outs').select('id, stage'),
      ]);

      const candidates = candidatesRes.data ?? [];
      const sendOuts = sendOutsRes.data ?? [];

      const countByJobStatus = (status: string) => candidates.filter(c => c.job_status === status).length;

      return {
        activeJobs: jobsRes.count ?? 0,
        totalCandidates: candidates.length,
        newCandidates: countByJobStatus('new'),
        contactedCandidates: countByJobStatus('reached_out'),
        pitchedCandidates: countByJobStatus('pitched'),
        sendOutCandidates: countByJobStatus('send_out'),
        submittedCandidates: countByJobStatus('submitted'),
        interviewingCandidates: countByJobStatus('interviewing'),
        offerCandidates: countByJobStatus('offer'),
        placedCandidates: countByJobStatus('placed'),
        interviewsThisWeek: sendOuts.filter((s) => s.stage === 'interview').length,
        offersOut: sendOuts.filter((s) => s.stage === 'offer').length,
        callsToday: 0,
        emailsSent: 0,
        responseRate: 0,
      };
    },
  });
}

// Integration accounts (sender accounts — all team accounts visible)
export function useIntegrationAccounts() {
  return useQuery({
    queryKey: ['integration_accounts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_accounts')
        .select('*')
        .eq('is_active', true)
        .order('account_label');
      if (error) throw error;
      return data;
    },
  });
}

// Candidates linked to a specific job
export function useJobCandidates(jobId: string | undefined) {
  return useQuery({
    queryKey: ['job_candidates', jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, first_name, last_name, full_name, current_title, current_company, job_status, status, email')
        .eq('job_id', jobId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Real activity feed — messages sent + notes added + enrollments, scoped to current user
export function useActivityFeed(limit = 20) {
  return useQuery({
    queryKey: ['activity_feed'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      const [messagesRes, notesRes, enrollmentsRes] = await Promise.all([
        supabase
          .from('messages')
          .select('id, channel, direction, body, subject, sender_address, recipient_address, sent_at, received_at, candidate_id, contact_id, candidates(full_name), contacts(full_name)')
          .eq('owner_id', user.id)
          .order('sent_at', { ascending: false, nullsFirst: false })
          .limit(limit),
        supabase
          .from('notes')
          .select('id, note, created_at, entity_type, entity_id, created_by')
          .eq('created_by', user.id)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase
          .from('sequence_enrollments')
          .select('id, enrolled_at, candidate_id, sequence_id, candidates(full_name), sequences(name)')
          .eq('enrolled_by', user.id)
          .order('enrolled_at', { ascending: false })
          .limit(limit),
      ]);

      const items: any[] = [];

      for (const msg of messagesRes.data ?? []) {
        const ts = msg.sent_at || msg.received_at;
        const personName = (msg.candidates as any)?.full_name || (msg.contacts as any)?.full_name || msg.recipient_address || msg.sender_address;
        const channelLabel = msg.channel === 'email' ? 'Email' : msg.channel === 'sms' ? 'SMS' : 'LinkedIn';
        const direction = msg.direction === 'outbound' ? 'sent' : 'received';
        items.push({
          id: `msg-${msg.id}`,
          type: msg.channel === 'email' ? 'email_sent' : msg.channel === 'sms' ? 'sms_sent' : 'linkedin_sent',
          description: `${channelLabel} ${direction}${personName ? ` — ${personName}` : ''}${msg.subject ? `: ${msg.subject}` : ''}`,
          timestamp: ts ? new Date(ts) : new Date(),
          candidateId: msg.candidate_id,
          contactId: msg.contact_id,
        });
      }

      for (const note of notesRes.data ?? []) {
        items.push({
          id: `note-${note.id}`,
          type: 'note_added',
          description: `Note added on ${note.entity_type}: ${note.note.slice(0, 80)}${note.note.length > 80 ? '…' : ''}`,
          timestamp: new Date(note.created_at),
        });
      }

      for (const enr of enrollmentsRes.data ?? []) {
        const candName = (enr.candidates as any)?.full_name;
        const seqName = (enr.sequences as any)?.name;
        items.push({
          id: `enr-${enr.id}`,
          type: 'enrolled',
          description: `${candName ?? 'Candidate'} enrolled in ${seqName ?? 'sequence'}`,
          timestamp: enr.enrolled_at ? new Date(enr.enrolled_at) : new Date(),
          candidateId: enr.candidate_id,
        });
      }

      return items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);
    },
  });
}
