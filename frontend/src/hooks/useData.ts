import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Candidates — includes new work_email, personal_email, mobile_phone, roles fields
export function useCandidates() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['candidates'],
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('candidates')
          .select('*, work_email, personal_email, mobile_phone, roles, linked_contact_id')
          .order('created_at', { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return allData;
    },
  });

  const candidatesChannelName = useRef(`candidates-changes-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const channel = supabase
      .channel(candidatesChannelName.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'candidates' }, (payload) => {
        console.log('Candidates change detected:', payload);
        queryClient.invalidateQueries({ queryKey: ['candidates'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
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
        .select('*, work_email, personal_email, mobile_phone, roles, linked_contact_id')
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

// Job functions lookup
export function useJobFunctions() {
  return useQuery({
    queryKey: ['job_functions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('job_functions')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Jobs with company info
export function useJobs(includesClosed = false) {
  return useQuery({
    queryKey: ['jobs', includesClosed],
    queryFn: async () => {
      let query = supabase
        .from('jobs')
        .select('*, companies(name, domain), job_functions(id, name, code, examples)')
        .order('created_at', { ascending: false });
      if (!includesClosed) {
        query = query.not('status', 'in', '("lost","closed","closed_won","closed_lost")');
      }
      const { data, error } = await query;
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
        .select('*, companies(name, domain, website), job_functions(id, name, code, examples)')
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

// Contacts with company + new fields
export function useContacts() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('contacts')
        .select('*, companies!left(name, domain), work_email, personal_email, mobile_phone, roles, linked_candidate_id')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const contactsChannelName = useRef(`contacts-changes-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const channel = supabase
      .channel(contactsChannelName.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, (payload) => {
        console.log('Contacts change detected:', payload);
        queryClient.invalidateQueries({ queryKey: ['contacts'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  return query;
}

// Unified people view — v_people (UNION ALL of candidates + contacts)
export function usePeople() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await (supabase.from('v_people' as any) as any)
          .select('*')
          .order('updated_at', { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return allData;
    },
  });

  const channelName = useRef(`people-changes-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const ch = supabase
      .channel(channelName.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'candidates' }, () => {
        queryClient.invalidateQueries({ queryKey: ['people'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => {
        queryClient.invalidateQueries({ queryKey: ['people'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
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
        .select('*, sequence_steps(*), sequence_nodes(id, node_order, node_type, label, sequence_actions(*)), sequence_enrollments(id), jobs(id, title, company_name)')
        .order('created_at', { ascending: false }) as any;
      if (error) throw error;
      return (data || []).map((sequence: any) => {
        if (sequence.sequence_steps?.length) return sequence;
        let derivedStepOrder = 0;
        const derivedSteps = (sequence.sequence_nodes || [])
          .sort((a: any, b: any) => a.node_order - b.node_order)
          .flatMap((node: any) =>
            ((node.sequence_actions || []) as any[]).map((action: any) => {
              derivedStepOrder += 1;
              return {
                id: action.id,
                step_order: derivedStepOrder,
                channel: action.channel,
                step_type: action.channel,
                body: action.message_body || '',
                delay_days: 0,
                delay_hours: Number(action.base_delay_hours) || 0,
                min_hours_after_connection: action.post_connection_hardcoded_hours || 4,
              };
            }),
          );
        return { ...sequence, sequence_steps: derivedSteps };
      });
    },
  });
}

// Sequence list metrics
export function useSequenceListMetrics() {
  return useQuery({
    queryKey: ['sequence_list_metrics'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sequence_step_executions')
        .select('status, sequence_enrollments!inner(sequence_id)');
      if (error) throw error;
      const metrics: Record<string, { sent: number; delivered: number; opened: number; replied: number; bounced: number }> = {};
      for (const row of data || []) {
        const seqId = (row as any).sequence_enrollments?.sequence_id;
        if (!seqId) continue;
        if (!metrics[seqId]) metrics[seqId] = { sent: 0, delivered: 0, opened: 0, replied: 0, bounced: 0 };
        const m = metrics[seqId];
        const s = row.status;
        if (s === 'sent' || s === 'delivered' || s === 'opened' || s === 'clicked' || s === 'replied') m.sent++;
        if (s === 'delivered' || s === 'opened' || s === 'clicked' || s === 'replied') m.delivered++;
        if (s === 'opened' || s === 'clicked' || s === 'replied') m.opened++;
        if (s === 'replied') m.replied++;
        if (s === 'bounced') m.bounced++;
      }
      return metrics;
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

// Messages (for Calls page)
export function useMessages(channel?: string) {
  return useQuery({
    queryKey: ['messages', channel],
    queryFn: async () => {
      let query = supabase
        .from('messages')
        .select('*, candidates(full_name)')
        .order('created_at', { ascending: false })
        .limit(100);
      if (channel) query = query.eq('channel', channel);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
}

function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const mon = new Date(now);
  mon.setDate(now.getDate() - diff);
  mon.setHours(0, 0, 0, 0);
  return mon.toISOString();
}

function getMonthStart(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export function useDashboardMetrics() {
  return useQuery({
    queryKey: ['dashboard_metrics'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const weekStart = getWeekStart();
      const monthStart = getMonthStart();
      const [jobsRes, candidatesWeekRes, candidatesMonthRes, sendOutsRes] = await Promise.all([
        supabase.from('jobs').select('id, status', { count: 'exact' }).eq('status', 'open'),
        supabase.from('candidates').select('id, job_status, owner_id').gte('created_at', weekStart),
        supabase.from('candidates').select('id, job_status, owner_id').gte('created_at', monthStart),
        supabase.from('send_outs').select('id, stage, created_at'),
      ]);
      const weekCandidates = candidatesWeekRes.data ?? [];
      const monthCandidates = candidatesMonthRes.data ?? [];
      const sendOuts = sendOutsRes.data ?? [];
      const countWeek = (status: string) =>
        weekCandidates.filter((c) =>
          status === 'interviewing' ? ['interview', 'interviewing'].includes(c.job_status) : c.job_status === status
        ).length;
      const countMonth = (status: string) =>
        monthCandidates.filter((c) =>
          status === 'interviewing' ? ['interview', 'interviewing'].includes(c.job_status) : c.job_status === status
        ).length;
      return {
        activeJobs: jobsRes.count ?? 0,
        weekCandidates: weekCandidates.length,
        myWeekCandidates: user ? weekCandidates.filter(c => c.owner_id === user.id).length : 0,
        weekNew: countWeek('new'), weekContacted: countWeek('reached_out'),
        weekPitched: countWeek('pitched'), weekSendOut: countWeek('send_out'),
        weekSubmitted: countWeek('submitted'), weekInterviewing: countWeek('interviewing'),
        weekOffer: countWeek('offer'), weekPlaced: countWeek('placed'),
        monthCandidates: monthCandidates.length,
        myMonthCandidates: user ? monthCandidates.filter(c => c.owner_id === user.id).length : 0,
        monthNew: countMonth('new'), monthContacted: countMonth('reached_out'),
        monthPitched: countMonth('pitched'), monthSendOut: countMonth('send_out'),
        monthSubmitted: countMonth('submitted'), monthInterviewing: countMonth('interviewing'),
        monthOffer: countMonth('offer'), monthPlaced: countMonth('placed'),
        interviewsThisWeek: sendOuts.filter((s) => ['interview', 'interviewing'].includes(s.stage)).length,
        offersOut: sendOuts.filter((s) => s.stage === 'offer').length,
      };
    },
  });
}

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
          description: `Note added on ${note.entity_type}: ${note.note.slice(0, 80)}${note.note.length > 80 ? '...' : ''}`,
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
