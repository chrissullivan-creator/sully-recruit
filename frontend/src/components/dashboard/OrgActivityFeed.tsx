import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useProfiles } from '@/hooks/useProfiles';
import { History, ArrowRight, FileText, UserCheck, Send, MessageSquare } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface ActivityRow {
  id: string;
  kind: 'stage' | 'note' | 'status' | 'message';
  at: string;
  actorName?: string | null;
  primary: string;
  secondary?: string | null;
  href?: string | null;
}

const LIMIT = 25;

export function OrgActivityFeed() {
  const navigate = useNavigate();
  const { data: profiles = [] } = useProfiles();
  const profileById = new Map(profiles.map((p) => [p.id, p.full_name || p.email || '?']));

  const { data: rows = [], isLoading } = useQuery<ActivityRow[]>({
    queryKey: ['org_activity_feed'],
    staleTime: 60_000,
    queryFn: async () => {
      // Pull each source individually then merge — this keeps each query
      // simple + indexable. We over-fetch from each so the merged top-N
      // has the right items even if one source is bursty.
      const PER_SOURCE = LIMIT * 2;

      // Stage transitions — needs candidate_job → candidate_id resolution
      // for click-through. We grab the most recent N transitions, then
      // fetch their candidate_jobs in one trip.
      const stageQ = supabase
        .from('stage_transitions')
        .select('id, entity_id, entity_type, from_stage, to_stage, created_at, trigger_source')
        .order('created_at', { ascending: false })
        .limit(PER_SOURCE);

      const noteQ = supabase
        .from('notes')
        .select('id, entity_type, entity_id, note, created_at, created_by')
        .order('created_at', { ascending: false })
        .limit(PER_SOURCE);

      const statusQ = supabase
        .from('status_change_log')
        .select('id, entity_type, entity_id, from_status, to_status, created_at, triggered_by')
        .order('created_at', { ascending: false })
        .limit(PER_SOURCE);

      const messageQ = supabase
        .from('messages')
        .select('id, candidate_id, contact_id, channel, direction, sent_at, body, subject')
        .order('sent_at', { ascending: false })
        .limit(PER_SOURCE);

      const [stageR, noteR, statusR, msgR] = await Promise.all([stageQ, noteQ, statusQ, messageQ]);

      // Resolve candidate_job → candidate_id for stage rows (entity_type='candidate_job').
      const cjIds = (stageR.data ?? [])
        .filter((s: any) => s.entity_type === 'candidate_job')
        .map((s: any) => s.entity_id);
      const cjMap = new Map<string, string>();
      if (cjIds.length > 0) {
        const { data } = await supabase
          .from('candidate_jobs')
          .select('id, candidate_id')
          .in('id', cjIds);
        for (const r of data ?? []) {
          if (r.id && r.candidate_id) cjMap.set(r.id, r.candidate_id);
        }
      }

      // Resolve candidate display names for the entities we link to.
      const candidateIds = new Set<string>();
      for (const s of stageR.data ?? []) {
        const id = s.entity_type === 'candidate_job' ? cjMap.get(s.entity_id) : s.entity_id;
        if (id) candidateIds.add(id);
      }
      for (const s of statusR.data ?? []) if (s.entity_id) candidateIds.add(s.entity_id);
      for (const m of msgR.data ?? []) {
        const id = m.candidate_id || m.contact_id;
        if (id) candidateIds.add(id);
      }
      const nameById = new Map<string, string>();
      if (candidateIds.size > 0) {
        const { data } = await supabase
          .from('people')
          .select('id, full_name, first_name, last_name, type')
          .in('id', Array.from(candidateIds));
        for (const p of data ?? []) {
          const name = (p as any).full_name || `${(p as any).first_name ?? ''} ${(p as any).last_name ?? ''}`.trim() || '—';
          nameById.set((p as any).id, name);
        }
      }

      const merged: ActivityRow[] = [];

      for (const t of stageR.data ?? []) {
        const candidateId = (t as any).entity_type === 'candidate_job'
          ? cjMap.get((t as any).entity_id)
          : (t as any).entity_id;
        const name = candidateId ? nameById.get(candidateId) : null;
        merged.push({
          id: `stage-${(t as any).id}`,
          kind: 'stage',
          at: (t as any).created_at,
          primary: `${name ?? 'A candidate'} moved ${(t as any).from_stage ?? '—'} → ${(t as any).to_stage}`,
          secondary: (t as any).trigger_source ?? null,
          href: candidateId ? `/candidates/${candidateId}` : null,
        });
      }
      for (const n of noteR.data ?? []) {
        merged.push({
          id: `note-${(n as any).id}`,
          kind: 'note',
          at: (n as any).created_at,
          actorName: (n as any).created_by ? profileById.get((n as any).created_by) : undefined,
          primary: 'Note added',
          secondary: ((n as any).note ?? '').slice(0, 120),
          href: (n as any).entity_type === 'job'
            ? `/jobs/${(n as any).entity_id}`
            : (n as any).entity_type === 'candidate'
              ? `/candidates/${(n as any).entity_id}`
              : (n as any).entity_type === 'contact'
                ? `/contacts/${(n as any).entity_id}`
                : null,
        });
      }
      for (const s of statusR.data ?? []) {
        const name = (s as any).entity_id ? nameById.get((s as any).entity_id) : null;
        merged.push({
          id: `status-${(s as any).id}`,
          kind: 'status',
          at: (s as any).created_at,
          primary: `${name ?? 'A person'} status ${(s as any).from_status ?? '—'} → ${(s as any).to_status}`,
          secondary: (s as any).triggered_by ?? null,
          href: (s as any).entity_id ? `/candidates/${(s as any).entity_id}` : null,
        });
      }
      for (const m of msgR.data ?? []) {
        const personId = (m as any).candidate_id || (m as any).contact_id;
        const name = personId ? nameById.get(personId) : null;
        if (!personId) continue;
        merged.push({
          id: `msg-${(m as any).id}`,
          kind: 'message',
          at: (m as any).sent_at,
          primary: `${(m as any).direction === 'outbound' ? 'Sent to' : 'Reply from'} ${name ?? '—'} via ${(m as any).channel}`,
          secondary: ((m as any).subject ?? (m as any).body ?? '').toString().replace(/<[^>]+>/g, '').slice(0, 120),
          href: (m as any).candidate_id ? `/candidates/${(m as any).candidate_id}` : `/contacts/${(m as any).contact_id}`,
        });
      }

      return merged
        .filter((r) => r.at)
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, LIMIT);
    },
  });

  return (
    <div className="rounded-lg border border-card-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-card-border flex items-center gap-2">
        <History className="h-4 w-4 text-emerald" />
        <h2 className="text-sm font-display font-semibold text-emerald-dark">Recent activity</h2>
        <span className="text-xs text-muted-foreground ml-auto">across the team</span>
      </div>
      {isLoading ? (
        <div className="px-5 py-6 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-3 bg-muted rounded animate-pulse" style={{ width: `${60 + (i * 8) % 40}%` }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">Nothing logged yet.</p>
      ) : (
        <div className="divide-y divide-card-border max-h-[28rem] overflow-y-auto">
          {rows.map((r) => {
            const Icon =
              r.kind === 'stage' ? ArrowRight :
              r.kind === 'note' ? FileText :
              r.kind === 'status' ? UserCheck :
              r.kind === 'message' ? MessageSquare :
              Send;
            return (
              <button
                key={r.id}
                onClick={() => r.href && navigate(r.href)}
                disabled={!r.href}
                className={cn(
                  'w-full text-left px-5 py-2.5 transition-colors flex items-start gap-3',
                  r.href ? 'hover:bg-emerald-light/15 cursor-pointer' : 'cursor-default',
                )}
              >
                <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{r.primary}</p>
                  {r.secondary && (
                    <p className="text-xs text-muted-foreground truncate">{r.secondary}</p>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0" title={format(new Date(r.at), 'PPP p')}>
                  {formatDistanceToNow(new Date(r.at), { addSuffix: true })}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
