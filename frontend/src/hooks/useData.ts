import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { compareSequenceNodes } from '@/components/sequences/sequenceBranches';

// Candidates — queries the people table (was renamed from candidates) and filters
// to type='candidate'. The `candidates` backwards-compat view still exists for
// untouched edge functions / Trigger.dev tasks.
export function useCandidates(opts?: { enabled?: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['candidates'],
    // Lets the Candidates page disable the full-table load when it falls back
    // to the server-side paginated search (useCandidatesSearch).
    enabled: opts?.enabled ?? true,
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('people')
          // Curated column set for the list/pipeline/filter views. Was
          // select('*'), which dragged down linkedin_profile_data (jsonb, ~8MB
          // across 8k rows) + the joe_says_embedding vector + other detail-only
          // columns on every Candidates-page load. None are rendered in the
          // list; the detail page fetches the full row via useCandidate(id).
          .select(
            'id, type, full_name, first_name, last_name, ' +
            'title, current_title, company_name, current_company, company_id, ' +
            'work_email, personal_email, email:primary_email, secondary_emails, mobile_phone, phone, linkedin_url, ' +
            'email_invalid, email_invalid_reason, email_invalid_at, ' +
            'avatar_url, profile_picture_url, roles, status, skills, location_text, ' +
            'last_contacted_at, last_responded_at, last_comm_channel, ' +
            'last_sequence_sentiment, last_sequence_sentiment_note, ' +
            'do_not_contact, linked_contact_id, owner_user_id, created_at, updated_at',
          )
          .eq('type', 'candidate')
          .is('deleted_at', null)
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

// Curated list columns — kept identical to useCandidates() so the row shape
// rendered by the Candidates list is the same whether it came from the full
// client-side load or this server-side paginated search.
const CANDIDATE_LIST_COLS =
  'id, type, full_name, first_name, last_name, ' +
  'title, current_title, company_name, current_company, company_id, ' +
  'work_email, personal_email, email:primary_email, secondary_emails, mobile_phone, phone, linkedin_url, ' +
  'email_invalid, email_invalid_reason, email_invalid_at, ' +
  'avatar_url, profile_picture_url, roles, status, skills, location_text, ' +
  'last_contacted_at, last_responded_at, last_comm_channel, ' +
  'last_sequence_sentiment, last_sequence_sentiment_note, ' +
  'do_not_contact, linked_contact_id, owner_user_id, created_at, updated_at';

/**
 * Server-side paginated candidate search. Powers the Candidates page's default
 * (sidebar-closed, no boolean/advanced filter) path so it stops loading the
 * entire table into the browser. Mirrors usePeopleSearch: simple ILIKE text
 * search across name/company/title/email plus the cheap structured filters
 * (status, owner), sorted + paged + exact count, server-side. The advanced
 * filters (boolean operators, radius, skills, title/company/jobTag/workauth/
 * dates) keep running client-side on the full load — see Candidates.tsx.
 */
export function useCandidatesSearch(params: {
  search: string;
  status: string;
  owner: string;
  userId?: string | null;
  sortField: string;
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  enabled: boolean;
}) {
  const { search, status, owner, userId, sortField, sortDir, page, pageSize, enabled } = params;
  return useQuery({
    // Nested under 'candidates' so existing invalidateQueries(['candidates'])
    // calls (incl. the realtime people-change subscription) refresh this
    // server page too via React Query's prefix matching.
    queryKey: ['candidates', 'search', search, status, owner, userId, sortField, sortDir, page, pageSize],
    enabled,
    queryFn: async () => {
      let q = supabase
        .from('people')
        .select(CANDIDATE_LIST_COLS, { count: 'exact' })
        .eq('type', 'candidate')
        .is('deleted_at', null);

      if (status !== 'all') q = q.eq('status', status);
      if (owner === 'mine' && userId) q = q.eq('owner_user_id', userId);
      else if (owner !== 'all' && owner !== 'mine') q = q.eq('owner_user_id', owner);

      // Sanitize so reserved PostgREST or()-filter chars can't break the query.
      const safe = search.replace(/[,()*%\\]/g, ' ').trim();
      if (safe) {
        const like = `*${safe}*`;
        q = q.or(
          [
            `full_name.ilike.${like}`,
            `first_name.ilike.${like}`,
            `last_name.ilike.${like}`,
            `current_company.ilike.${like}`,
            `company_name.ilike.${like}`,
            `current_title.ilike.${like}`,
            `title.ilike.${like}`,
            `primary_email.ilike.${like}`,
            `work_email.ilike.${like}`,
            `personal_email.ilike.${like}`,
          ].join(','),
        );
      }

      const sortCol =
        sortField === 'name' ? 'full_name'
        : sortField === 'title' ? 'current_title'
        : sortField === 'company' ? 'current_company'
        : sortField === 'status' ? 'status'
        : sortField === 'created' ? 'created_at'
        : 'updated_at';
      q = q.order(sortCol, { ascending: sortDir === 'asc', nullsFirst: false });

      const from = (page - 1) * pageSize;
      q = q.range(from, from + pageSize - 1);

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as any[], total: count ?? 0 };
    },
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
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

// Admin-defined custom field definitions for an entity type
// ('candidate' | 'client' | 'company' | 'job'). Returns only active fields,
// ordered by display_order. Cached aggressively — defs change rarely.
export type CustomFieldDef = {
  id: string;
  entity_type: string;
  key: string;
  label: string;
  field_type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect' | 'url';
  options: string[];
  required: boolean;
  section: string | null;
  display_order: number;
  is_active: boolean;
};

export function useCustomFieldDefs(entityType: string | undefined, includeInactive = false) {
  return useQuery({
    queryKey: ['custom_field_defs', entityType, includeInactive],
    enabled: !!entityType,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // custom_field_defs isn't in the generated Supabase types yet — cast to
      // any so the query builder doesn't resolve to `never`.
      let q = (supabase.from('custom_field_defs' as any) as any)
        .select('*')
        .eq('entity_type', entityType!)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (!includeInactive) q = q.eq('is_active', true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((d: any) => ({
        ...d,
        options: Array.isArray(d.options) ? d.options : [],
      })) as CustomFieldDef[];
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
      // send_out_board view doesn't exist; query send_outs directly
      // and stitch job/candidate identity client-side.
      const { data: rows, error } = await supabase
        .from('send_outs')
        .select('*, jobs:job_id (id, title, location_text, comp_min, comp_max)')
        .eq('candidate_id', candidateId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (rows ?? []) as any[];
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
        .select('*, companies(name, domain, logo_url), job_functions(id, name, code, examples)')
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (!includesClosed) {
        query = query.not('status', 'in', '("filled","closed_lost")');
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
        .select('*, companies(name, domain, website, logo_url), job_functions(id, name, code, examples)')
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
      // Page through ALL companies. A plain select caps at PostgREST's default
      // 1000 rows; ordered created_at desc, that silently dropped the oldest
      // companies from the list, the search box, AND every CompanyCombobox
      // picker — so an older company that exists looked un-addable + unfindable.
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from('companies')
          .select('*, jobs(id)')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return allData.map((c) => ({
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
      // Paginate past PostgREST's 1000-row cap (mirrors useCandidates). With
      // >1000 clients a single select silently dropped the rest, which made
      // enrollment + people pickers report older contacts as "could not be
      // resolved" and hid them from contact lists entirely.
      const PAGE_SIZE = 1000;
      let allData: any[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*, companies!left(name, domain), work_email, personal_email, mobile_phone, roles, linked_candidate_id')
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

// Server-side search + pagination for the People page. Replaces "download all
// ~14k rows and filter in JS" — the DB now does filtering/sorting/paging and
// returns one page at a time. Search is trigram-indexed (see migration
// 20260622000000). Tab filter uses the roles[] GIN index so dual-role people
// show under both Candidates and Clients, matching the old client-side logic.
const PEOPLE_LIST_COLS =
  'id, type, full_name, first_name, last_name, ' +
  'title, current_title, company_name, current_company, company_id, ' +
  'work_email, personal_email, email:primary_email, secondary_emails, mobile_phone, phone, linkedin_url, ' +
  'email_invalid, email_invalid_reason, email_invalid_at, ' +
  'avatar_url, roles, status, ' +
  'last_contacted_at, last_responded_at, last_comm_channel, last_sequence_sentiment, last_sequence_sentiment_note, ' +
  'owner_user_id, created_at, updated_at';

export function usePeopleSearch(params: {
  search: string;
  tab: 'all' | 'candidates' | 'clients' | 'applicants';
  sortField: string;
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
}) {
  const { search, tab, sortField, sortDir, page, pageSize } = params;
  return useQuery({
    queryKey: ['people_search', search, tab, sortField, sortDir, page, pageSize],
    enabled: tab !== 'applicants',
    queryFn: async () => {
      let q = supabase
        .from('people')
        .select(PEOPLE_LIST_COLS, { count: 'exact' })
        .is('deleted_at', null);

      if (tab === 'candidates') q = q.contains('roles', ['candidate']);
      else if (tab === 'clients') q = q.contains('roles', ['client']);

      // Sanitize so reserved PostgREST or()-filter chars can't break the query.
      const safe = search.replace(/[,()*%\\]/g, ' ').trim();
      if (safe) {
        const like = `*${safe}*`;
        q = q.or(
          [
            `full_name.ilike.${like}`,
            `current_company.ilike.${like}`,
            `company_name.ilike.${like}`,
            `current_title.ilike.${like}`,
            `title.ilike.${like}`,
            `primary_email.ilike.${like}`,
            `work_email.ilike.${like}`,
            `personal_email.ilike.${like}`,
          ].join(','),
        );
      }

      const sortCol =
        sortField === 'name' ? 'full_name'
        : sortField === 'title' ? 'current_title'
        : sortField === 'company' ? 'current_company'
        : sortField === 'lastReached' ? 'last_contacted_at'
        : sortField === 'lastResponded' ? 'last_responded_at'
        : sortField === 'created' ? 'created_at'
        : 'updated_at';
      q = q.order(sortCol, { ascending: sortDir === 'asc', nullsFirst: false });

      const from = (page - 1) * pageSize;
      q = q.range(from, from + pageSize - 1);

      const { data, error, count } = await q;
      if (error) throw error;
      const rows = ((data ?? []) as any[]).map((p) => ({
        ...p,
        source_table: p.type === 'client' ? 'contact' : 'candidate',
        title: p.title ?? p.current_title ?? null,
        company_name: p.company_name ?? p.current_company ?? null,
      }));
      return { rows, total: count ?? 0 };
    },
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
}

export function usePeopleTabCounts() {
  return useQuery({
    queryKey: ['people_tab_counts'],
    staleTime: 60_000,
    queryFn: async () => {
      const base = () =>
        supabase.from('people').select('id', { count: 'exact', head: true }).is('deleted_at', null);
      const [all, cand, cli] = await Promise.all([
        base(),
        base().contains('roles', ['candidate']),
        base().contains('roles', ['client']),
      ]);
      return { all: all.count ?? 0, candidates: cand.count ?? 0, clients: cli.count ?? 0 };
    },
  });
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
            'title, current_title, company_name, current_company, company_id, ' +
            'work_email, personal_email, email:primary_email, secondary_emails, mobile_phone, phone, linkedin_url, ' +
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
        // sequence_steps was the v1 schema; it was dropped in the v2
        // migration (replaced by sequence_nodes + sequence_actions).
        // Selecting it threw a SelectQueryError that nuked the entire
        // sequences fetch — Enroll dialogs went empty everywhere.
        .from('sequences')
        .select('*, sequence_nodes(id, node_order, node_type, label, branch_id, branch_step_order, sequence_actions(*)), sequence_enrollments(id), jobs(id, title, company_name)')
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
      // Was `sequence_step_executions` (legacy v1 table). The v2 schema
      // tracks deliveries in sequence_step_logs.
      const { data, error } = await supabase
        .from('sequence_step_logs')
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

// Per-channel send caps (channel_limits table). These are the SAME limits the
// engine enforces in send-time-calculator — surfaced here so the builder /
// schedule view and the Settings editor all read one source of truth instead
// of hardcoded constants.
export interface ChannelLimit {
  channel: string;
  daily_max: number | null;
  hourly_max: number | null;
}

export function useChannelLimits() {
  return useQuery({
    queryKey: ['channel_limits'],
    queryFn: async (): Promise<Record<string, ChannelLimit>> => {
      const { data, error } = await supabase
        .from('channel_limits')
        .select('channel, daily_max, hourly_max');
      if (error) throw error;
      const map: Record<string, ChannelLimit> = {};
      for (const row of (data || []) as ChannelLimit[]) map[row.channel] = row;
      return map;
    },
    staleTime: 60_000,
  });
}

// Send outs for a specific job
export function useJobSendOuts(jobId: string | undefined) {
  return useQuery({
    queryKey: ['send_outs_job', jobId],
    enabled: !!jobId,
    queryFn: async () => {
      // The `send_out_board` view referenced earlier doesn't exist in
      // the current schema, which is why newly-added send-outs were
      // silently disappearing. Query send_outs directly and stitch
      // candidate identity client-side so we don't depend on PostgREST
      // detecting the FK relationship.
      const { data: rows, error } = await supabase
        .from('send_outs')
        .select('*')
        .eq('job_id', jobId!)
        // Exclude soft-deleted rows so Job Detail counts match the main Send
        // Outs page (useSendOuts), which filters deleted_at IS NULL. Without
        // this, deleted send-outs inflated the Job Detail tab/sidebar counts.
        .is('deleted_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;

      const ids = Array.from(
        new Set(((rows ?? []) as any[]).map((r) => r.candidate_id).filter(Boolean)),
      );
      let byId = new Map<string, any>();
      if (ids.length) {
        const { data: people } = await supabase
          .from('people')
          .select('id, full_name, first_name, last_name, current_title, current_company, email:primary_email, phone, resume_url, avatar_url, type, linkedin_url, target_total_comp, target_base_comp')
          .in('id', ids);
        byId = new Map(((people ?? []) as any[]).map((p) => [p.id, p]));
      }

      return ((rows ?? []) as any[]).map((row) => {
        const c = row.candidate_id ? byId.get(row.candidate_id) : null;
        return {
          ...row,
          candidate: c ?? null,
          candidate_name: c?.full_name ?? null,
          resume_url: row.resume_url ?? c?.resume_url ?? null,
        };
      });
    },
  });
}

// Send out board — was a view, now read straight from send_outs and
// stitch identity columns client-side. Same shape as before so the
// kanban consumers don't change.
export function useSendOutBoard() {
  return useQuery({
    queryKey: ['send_out_board'],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('send_outs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const ids = Array.from(
        new Set(((rows ?? []) as any[]).map((r) => r.candidate_id).filter(Boolean)),
      );
      let byId = new Map<string, any>();
      if (ids.length) {
        const { data: people } = await supabase
          .from('people')
          .select('id, full_name, current_title, current_company, email:primary_email, resume_url')
          .in('id', ids);
        byId = new Map(((people ?? []) as any[]).map((p) => [p.id, p]));
      }

      return ((rows ?? []) as any[]).map((row) => {
        const c = row.candidate_id ? byId.get(row.candidate_id) : null;
        return {
          ...row,
          candidate: c ?? null,
          candidate_name: c?.full_name ?? null,
          resume_url: row.resume_url ?? c?.resume_url ?? null,
        };
      });
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
// filter ("me" view). Funnel counts are sourced per stage by what the stage means:
//   - Pitch / Send Out: candidate_jobs.pipeline_stage filtered by stage_updated_at
//     (pre-submission queue; no send_outs row exists yet).
//   - Submission / Interview / Offer: send_outs filtered by the stage-specific event
//     timestamp (sent_to_client_at / interview_at / offer_at) — NOT updated_at, which
//     bumps on any edit.
//   - Rejection: the dedicated rejections table filtered by rejected_at.
// Person-status counts are exact COUNTs over people WHERE type='candidate' AND
// deleted_at IS NULL with the range applied to people.updated_at (clients are excluded
// so the tiles don't double-count). All people/jobs/send_outs queries filter
// deleted_at IS NULL (rejections/interviews have no such column).
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

      // Weekly activity counts. The dashboard's People cards are a per-period
      // scoreboard (default range = This Week, so they reset every Monday),
      // counted off the REAL event timestamp for each metric rather than a
      // status flag:
      //   New         → created_at         (people added this period)
      //   Reached Out → last_contacted_at  (people we contacted this period)
      //   Engaged     → last_responded_at  (people who responded this period)
      // This replaces the old status-by-updated_at count, which collapsed
      // "Reached Out" to whatever rows were merely touched in the window
      // (~1k) instead of a meaningful weekly number. head+count:'exact' to
      // dodge the 1000-row select cap on large buckets.
      const peopleActivityCount = (column: 'created_at' | 'last_contacted_at' | 'last_responded_at') => {
        let q = supabase.from('people')
          .select('id', { count: 'exact', head: true })
          .eq('type', 'candidate')
          .is('deleted_at', null)
          .gte(column, fromIso).lte(column, toIso);
        if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
        return q;
      };

      // Helper: full candidate rows for a status (capped) — used by the detail lists.
      const peopleByStatus = (status: string) => {
        let q = supabase.from('people')
          .select('id, full_name, first_name, last_name, current_title, current_company, owner_user_id, updated_at, status')
          .eq('type', 'candidate')
          .is('deleted_at', null)
          .eq('status', status)
          .gte('updated_at', fromIso).lte('updated_at', toIso)
          .order('updated_at', { ascending: false });
        if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
        return q;
      };

      const [
        jobsRes,
        candidatesCreatedRes,
        // Person-level status counts (exact) + lists
        newCountRes,
        reachedOutCountRes,
        engagedCountRes,
        engagedRes,
        // Pipeline aggregation across all jobs in range (pre-submission stages)
        candidateJobsInRangeRes,
        // Submission / Interview / Offer counts — from send_outs stage-event timestamps
        submittedCountRes,
        interviewCountRes,
        offerCountRes,
        // Rejection count — from the dedicated rejections table
        rejectionCountRes,
        // Detail panel sources (kept for the existing list UI)
        sendOutsInRangeRes,
        interviewsInRangeRes,
        // State-of-the-world send_outs for in-flight metric
        sendOutsAllRes,
      ] = await Promise.all([
        // Active jobs (state-of-the-world, not range-bound, owner-agnostic).
        // Leads are NOT active — only 'active' + 'hot' jobs count.
        supabase
          .from('jobs')
          .select('id, status', { count: 'exact', head: true })
          .in('status', ['active', 'hot'])
          .is('deleted_at', null),

        // Candidates created in range (owner-filtered)
        (() => {
          let q = supabase.from('people')
            .select('id', { count: 'exact', head: true })
            .eq('type', 'candidate')
            .is('deleted_at', null)
            .gte('created_at', fromIso).lte('created_at', toIso);
          if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
          return q;
        })(),

        // Weekly activity counts (per-period, candidates only)
        peopleActivityCount('created_at'),        // New: added this period
        peopleActivityCount('last_contacted_at'), // Reached Out: contacted this period
        peopleActivityCount('last_responded_at'), // Engaged: responded this period
        // Engaged list (rows) for the detail panel
        peopleByStatus('engaged'),

        // Candidate-jobs grouped by pipeline_stage in range — source for the
        // pre-submission funnel cells (Pitch, Send Out). Uses stage_updated_at so
        // cards count as "in stage" only when the transition happened in-window.
        applyOwner(supabase.from('candidate_jobs')
          .select('id, candidate_id, job_id, pipeline_stage, stage_updated_at, updated_at')
          .gte('stage_updated_at', fromIso).lte('stage_updated_at', toIso)),

        // Submission count — send_outs sent to client in range (stage-specific ts)
        (() => {
          let q = supabase.from('send_outs')
            .select('id', { count: 'exact', head: true })
            .is('deleted_at', null)
            .gte('sent_to_client_at', fromIso).lte('sent_to_client_at', toIso);
          if (ownedCandidateIds) q = q.in('candidate_id', ownedCandidateIds);
          return q;
        })(),

        // Interview count — send_outs whose interview was scheduled in range
        (() => {
          let q = supabase.from('send_outs')
            .select('id', { count: 'exact', head: true })
            .is('deleted_at', null)
            .gte('interview_at', fromIso).lte('interview_at', toIso);
          if (ownedCandidateIds) q = q.in('candidate_id', ownedCandidateIds);
          return q;
        })(),

        // Offer count — send_outs with an offer extended in range (offer_at, not stage)
        (() => {
          let q = supabase.from('send_outs')
            .select('id', { count: 'exact', head: true })
            .is('deleted_at', null)
            .gte('offer_at', fromIso).lte('offer_at', toIso);
          if (ownedCandidateIds) q = q.in('candidate_id', ownedCandidateIds);
          return q;
        })(),

        // Rejection count — dedicated rejections table, rejected_at in range
        // (rejections has no deleted_at column).
        (() => {
          let q = supabase.from('rejections')
            .select('id', { count: 'exact', head: true })
            .gte('rejected_at', fromIso).lte('rejected_at', toIso);
          if (ownedCandidateIds) q = q.in('candidate_id', ownedCandidateIds);
          return q;
        })(),

        // Send-outs joined for the Send Outs detail panel
        (() => {
          let q = supabase.from('send_outs')
            .select(`id, stage, sent_to_client_at, interview_at, updated_at, created_at,
              candidate_id, job_id, recruiter_id,
              candidate:people!candidate_id!inner(id, full_name, first_name, last_name, current_title, owner_user_id),
              jobs!inner(title, company_name)`)
            .is('deleted_at', null)
            .gte('updated_at', fromIso).lte('updated_at', toIso)
            .order('updated_at', { ascending: false });
          if (ownerUserId) q = q.eq('candidate.owner_user_id', ownerUserId);
          return q;
        })(),

        // Interviews stage table — joined for the list panel
        // (interviews has no deleted_at column).
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

        // Send-outs (state-of-the-world, for in-flight metric)
        (() => {
          let q = supabase.from('send_outs').select('id, stage, candidate_id').is('deleted_at', null);
          if (ownedCandidateIds) q = q.in('candidate_id', ownedCandidateIds);
          return q;
        })(),
      ]);

      const sendOuts         = sendOutsAllRes.data       ?? [];
      const engagedList      = (engagedRes.data          ?? []) as any[];
      const sendOutsInRange  = (sendOutsInRangeRes.data  ?? []) as any[];
      const interviewList    = (interviewsInRangeRes.data?? []) as any[];
      const cjRows           = (candidateJobsInRangeRes.data ?? []) as any[];

      // Pre-submission funnel cells (Pitch, Send Out) come from candidate_jobs —
      // these rows haven't been sent to a client yet (a send_outs row is created
      // at the moment of submission). Submission / Interview / Offer / Rejection
      // are counted server-side from stage-specific event timestamps above.
      const inCJStage = (stages: string[]) =>
        cjRows.filter((r: any) => stages.includes(r.pipeline_stage));

      const pitchList     = inCJStage(['pitch', 'pitched']);
      const sendOutListCJ = inCJStage(['ready_to_send', 'send_out', 'sendout']);

      return {
        activeJobs: jobsRes.count ?? 0,
        candidatesInRange: candidatesCreatedRes.count ?? 0,
        // Person status counts (exact, candidates only)
        newCount: newCountRes.count ?? 0,
        reachedOutCount: reachedOutCountRes.count ?? 0,
        engagedCount: engagedCountRes.count ?? 0,
        // 6-stage funnel — pre-submission from candidate_jobs, rest from
        // stage-specific event timestamps (send_outs / rejections) in range.
        pitchedCount:   pitchList.length,
        sendOutCount:   sendOutListCJ.length,
        submittedCount: submittedCountRes.count ?? 0,
        interviewCount: interviewCountRes.count ?? 0,
        offerCount:     offerCountRes.count ?? 0,
        rejectedCount:  rejectionCountRes.count ?? 0,
        // In-flight (state-of-the-world)
        interviewsInFlight: sendOuts.filter((s: any) => ['interview', 'interviewing'].includes(s.stage)).length,
        offersOut:          sendOuts.filter((s: any) => s.stage === 'offer').length,
        // Detail lists
        engagedList,
        sendOutList: sendOutsInRange,
        interviewList,
        // Funnel detail (raw candidate_jobs rows per pre-submission cell)
        cjPitchList: pitchList,
        cjSendOutList: sendOutListCJ,
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
        .select('id, first_name, last_name, full_name, current_title, current_company, job_status, status, email:primary_email')
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
