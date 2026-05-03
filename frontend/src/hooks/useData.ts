import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { compareSequenceNodes } from '@/components/sequences/sequenceBranches';

// Candidates — queries the people table (was renamed from candidates) and filters
// to type='candidate'. The `candidates` backwards-compat view still exists for
// untouched edge functions / Trigger.dev tasks.
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
          .from('people')
          .select('*, work_email, personal_email, mobile_phone, roles, linked_contact_id')
          .eq('type', 'candidate')
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'people' }, (payload) => {
        console.log('People change detected:', payload);
        queryClient.invalidateQueries({ queryKey: ['candidates'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  return query;
}

// Single person by ID — queries people table directly. Keep export name 'useCandidate'
// for now; callers don't care about the rename.
export function useCandidate(id: string | undefined) {
  return useQuery({
    queryKey: ['candidate', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('people')
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

// Unified people — queries the people table directly (was renamed from candidates).
// Title/company normalized in JS since both candidate-side (current_title, current_company)
// and client-side (title, company_name) columns coexist on the unified row.
export function usePeople() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('people')
          .select(
            'id, type, full_name, first_name, last_name, ' +
            'title, current_title, company_name, current_company, ' +
            'work_email, personal_email, email, mobile_phone, phone, linkedin_url, ' +
            'avatar_url, roles, status, ' +
            'last_contacted_at, last_responded_at, last_comm_channel, last_sequence_sentiment, ' +
            'owner_user_id, created_at, updated_at',
          )
          .order('updated_at', { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return allData.map((p: any) => ({
        ...p,
        source_table: p.type === 'client' ? 'contact' : 'candidate',
        title: p.title ?? p.current_title ?? null,
        company_name: p.company_name ?? p.current_company ?? null,
      }));
    },
  });

  const channelName = useRef(`people-changes-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const ch = supabase
      .channel(channelName.current)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'people' }, () => {
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
        .select('*, sequence_steps(*), sequence_nodes(id, node_order, node_type, label, branch_id, branch_step_order, sequence_actions(*)), sequence_enrollments(id), jobs(id, title, company_name)')
        .order('created_at', { ascending: false }) as any;
      if (error) throw error;
      return (data || []).map((sequence: any) => {
        if (sequence.sequence_steps?.length) return sequence;

        let derivedStepOrder = 0;
        const derivedSteps = (sequence.sequence_nodes || [])
          .sort(compareSequenceNodes)
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
        .select('*, people!candidate_id(full_name)')
        .order('created_at', { ascending: false })
        .limit(100);
      if (channel) query = query.eq('channel', channel);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
}

// Dashboard metrics — accepts an arbitrary [from, to] range AND an optional ownerUserId
// filter ("me" view). Counts come from the 6 canonical stage tables (pitches, send_outs,
// submissions, interviews, placements, rejections), each filtered by its own happened-at
// timestamp inside the range. NOTE: this does NOT read candidate_jobs.pipeline_stage —
// candidate_jobs holds CURRENT state per (candidate, job); the funnel reports EVENTS in
// a window. To make a candidate appear in the funnel, write to the matching event table.
export function useDashboardMetrics(range: { from: Date; to: Date }, ownerUserId?: string | null) {
  const fromIso = range.from.toISOString();
  const toIso   = range.to.toISOString();

  return useQuery({
    queryKey: ['dashboard_metrics', fromIso, toIso, ownerUserId ?? 'all'],
    queryFn: async () => {
      // Resolve which candidate_ids this owner has — used to filter pipeline + stage tables.
      // If ownerUserId is null/undefined, no owner filter is applied (whole team view).
      let ownedCandidateIds: string[] | null = null;
      if (ownerUserId) {
        const { data: ownedCands } = await supabase
          .from('people')
          .select('id')
          .eq('owner_user_id', ownerUserId);
        ownedCandidateIds = (ownedCands ?? []).map((c: any) => c.id);
        // If the owner has no candidates, every downstream IN-filter would match nothing.
        // Use a sentinel UUID list to short-circuit.
        if (ownedCandidateIds.length === 0) ownedCandidateIds = ['00000000-0000-0000-0000-000000000000'];
      }

      const applyOwner = (q: any) =>
        ownedCandidateIds ? q.in('candidate_id', ownedCandidateIds) : q;

      // Helper: people with a given status whose row was last updated inside the range.
      const peopleByStatus = (status: string) => {
        let q = supabase.from('people')
          .select('id, full_name, first_name, last_name, current_title, current_company, owner_user_id, updated_at, status')
          .eq('status', status)
          .gte('updated_at', fromIso).lte('updated_at', toIso)
          .order('updated_at', { ascending: false });
        if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
        return q;
      };

      const [
        jobsRes,
        candidatesCreatedRes,
        // Person-level statuses
        newRes,
        reachedOutRes,
        engagedRes,
        // 6 stage tables = the canonical funnel
        pitchesRes,
        sendOutsInRangeRes,
        submissionsRes,
        interviewsInRangeRes,
        placementsInRangeRes,
        rejectionsInRangeRes,
        // State-of-the-world send_outs for in-flight metric
        sendOutsAllRes,
      ] = await Promise.all([
        // Active jobs (state-of-the-world, not range-bound, owner-agnostic)
        supabase
          .from('jobs')
          .select('id, status', { count: 'exact' })
          .not('status', 'in', '("lost","closed","closed_won","closed_lost")'),

        // Candidates created in range (owner-filtered)
        (() => {
          let q = supabase.from('people')
            .select('id, owner_user_id, created_at')
            .gte('created_at', fromIso).lte('created_at', toIso);
          if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
          return q;
        })(),

        // Person status counts (and lists) — updated in range
        peopleByStatus('new'),
        peopleByStatus('reached_out'),
        peopleByStatus('engaged'),

        // Pitches stage table
        applyOwner(supabase.from('pitches').select('id, candidate_id, job_id, pitched_at')
          .gte('pitched_at', fromIso).lte('pitched_at', toIso)),

        // Send-outs stage table — joined for the list panel; matches sent OR interviewing stages in range
        (() => {
          let q = supabase.from('send_outs')
            .select(`id, stage, sent_to_client_at, interview_at, updated_at, created_at,
              candidate_id, job_id, recruiter_id,
              candidate:people!candidate_id!inner(id, full_name, first_name, last_name, current_title, owner_user_id),
              jobs!inner(title, company_name)`)
            .gte('updated_at', fromIso).lte('updated_at', toIso)
            .order('updated_at', { ascending: false });
          if (ownerUserId) q = q.eq('candidate.owner_user_id', ownerUserId);
          return q;
        })(),

        // Submissions stage table
        applyOwner(supabase.from('submissions').select('id, candidate_id, job_id, submitted_at')
          .gte('submitted_at', fromIso).lte('submitted_at', toIso)),

        // Interviews stage table — joined for the list panel
        (() => {
          let q = supabase.from('interviews')
            .select(`id, candidate_id, job_id, scheduled_at, end_at, stage, round, interviewer_name, interviewer_company, location, meeting_link, calendar_event_id,
              candidate:people!candidate_id!inner(id, full_name, first_name, last_name, current_title, owner_user_id),
              jobs!inner(title, company_name)`)
            .gte('scheduled_at', fromIso).lte('scheduled_at', toIso)
            .order('scheduled_at', { ascending: true, nullsFirst: false });
          if (ownerUserId) q = q.eq('candidate.owner_user_id', ownerUserId);
          return q;
        })(),

        // Placements stage table
        applyOwner(supabase.from('placements').select('id, candidate_id, job_id, placed_at, salary')
          .gte('placed_at', fromIso).lte('placed_at', toIso)),

        // Rejections stage table
        applyOwner(supabase.from('rejections').select('id, candidate_id, job_id, rejected_at, rejected_by_party, prior_stage, rejection_reason')
          .gte('rejected_at', fromIso).lte('rejected_at', toIso)),

        // Send-outs (state-of-the-world, for in-flight metric)
        (() => {
          let q = supabase.from('send_outs').select('id, stage, candidate_id');
          if (ownedCandidateIds) q = q.in('candidate_id', ownedCandidateIds);
          return q;
        })(),
      ]);

      const candidates       = candidatesCreatedRes.data ?? [];
      const sendOuts         = sendOutsAllRes.data       ?? [];
      const newList          = (newRes.data              ?? []) as any[];
      const reachedOutList   = (reachedOutRes.data       ?? []) as any[];
      const engagedList      = (engagedRes.data          ?? []) as any[];
      const sendOutsInRange  = (sendOutsInRangeRes.data  ?? []) as any[];
      const interviewList    = (interviewsInRangeRes.data?? []) as any[];

      // Offers in range — derived from send_outs with stage='offer' updated in range.
      const offerList = sendOutsInRange.filter((s: any) => s.stage === 'offer');

      return {
        activeJobs: jobsRes.count ?? 0,
        candidatesInRange: candidates.length,
        // Person status counts
        newCount: newList.length,
        reachedOutCount: reachedOutList.length,
        engagedCount: engagedList.length,
        // 6-stage funnel — one card per stage table, no fallback
        pitchedCount:   (pitchesRes.data        ?? []).length,
        sendOutCount:   sendOutsInRange.length,
        submittedCount: (submissionsRes.data    ?? []).length,
        interviewCount: interviewList.length,
        offerCount:     offerList.length,
        placedCount:    (placementsInRangeRes.data ?? []).length,
        rejectedCount:  (rejectionsInRangeRes.data ?? []).length,
        // In-flight (state-of-the-world)
        interviewsInFlight: sendOuts.filter((s: any) => ['interview', 'interviewing'].includes(s.stage)).length,
        offersOut:          sendOuts.filter((s: any) => s.stage === 'offer').length,
        // Detail lists
        newList,
        reachedOutList,
        engagedList,
        sendOutList: sendOutsInRange,
        interviewList,
        offerList,
        placementList: (placementsInRangeRes.data ?? []) as any[],
        rejectionList: (rejectionsInRangeRes.data ?? []) as any[],
      };
    },
  });
}

// Team members for the dashboard "user filter" picker.
export function useTeamMembers() {
  return useQuery({
    queryKey: ['team_members'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .order('full_name', { ascending: true });
      if (error) throw error;
      return (data ?? []).filter((p: any) => p.full_name || p.email);
    },
    staleTime: 5 * 60 * 1000,
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
        .from('people')
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
          .select('id, channel, direction, body, subject, sender_address, recipient_address, sent_at, received_at, candidate_id, contact_id, candidate:people!candidate_id(full_name), contact:people!contact_id(full_name)')
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
          .select('id, enrolled_at, candidate_id, sequence_id, people!candidate_id(full_name), sequences(name)')
          .eq('enrolled_by', user.id)
          .order('enrolled_at', { ascending: false })
          .limit(limit),
      ]);
      const items: any[] = [];
      for (const msg of messagesRes.data ?? []) {
        const ts = msg.sent_at || msg.received_at;
        const personName = (msg.candidate as any)?.full_name || (msg.contact as any)?.full_name || msg.recipient_address || msg.sender_address;
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
        const candName = (enr.people as any)?.full_name;
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
