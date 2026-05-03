import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { History, ArrowRight, FileText, Calendar } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

interface JobActivityFeedProps {
  jobId: string;
  /** When > 0, render only this many rows; default 10. */
  limit?: number;
}

interface ActivityRow {
  id: string;
  kind: 'stage' | 'note' | 'status';
  at: string;
  label: string;
  detail: string | null;
  /** Candidate the row is about (for stage/status rows) — used for click-through. */
  candidateId: string | null;
}

export function JobActivityFeed({ jobId, limit = 10 }: JobActivityFeedProps) {
  const navigate = useNavigate();
  const { data = [], isLoading } = useQuery({
    queryKey: ['job_activity', jobId, limit],
    enabled: !!jobId,
    queryFn: async () => {
      // Stage transitions where the candidate_job belongs to this job.
      const { data: cjRows } = await supabase
        .from('candidate_jobs')
        .select('id, candidate_id')
        .eq('job_id', jobId);
      const cjIds = (cjRows ?? []).map((r) => r.id);
      const candidateIds = (cjRows ?? []).map((r) => r.candidate_id).filter(Boolean) as string[];
      // Map candidate_jobs.id → candidate_id so stage rows can link back to the person.
      const cjIdToCandidate = new Map<string, string>();
      for (const r of (cjRows ?? [])) {
        if (r.id && r.candidate_id) cjIdToCandidate.set(r.id, r.candidate_id);
      }

      const transitions = cjIds.length > 0
        ? (await supabase
            .from('stage_transitions')
            .select('id, entity_id, from_stage, to_stage, trigger_source, created_at')
            .in('entity_id', cjIds)
            .order('created_at', { ascending: false })
            .limit(limit)).data ?? []
        : [];

      // Notes for this job (entity_type='job').
      const { data: notes } = await supabase
        .from('notes')
        .select('id, note, created_at, created_by')
        .eq('entity_type', 'job')
        .eq('entity_id', jobId)
        .order('created_at', { ascending: false })
        .limit(limit);

      // Status changes on candidates linked to this job.
      const statusLog = candidateIds.length > 0
        ? (await supabase
            .from('status_change_log')
            .select('id, entity_id, from_status, to_status, created_at, triggered_by')
            .eq('entity_type', 'candidate')
            .in('entity_id', candidateIds)
            .order('created_at', { ascending: false })
            .limit(limit)).data ?? []
        : [];

      const merged: ActivityRow[] = [
        ...transitions.map((t: any) => ({
          id: `stage-${t.id}`, kind: 'stage' as const, at: t.created_at,
          label: `Stage moved: ${t.from_stage ?? '—'} → ${t.to_stage}`,
          detail: t.trigger_source ?? null,
          candidateId: cjIdToCandidate.get(t.entity_id) ?? null,
        })),
        ...(notes ?? []).map((n: any) => ({
          id: `note-${n.id}`, kind: 'note' as const, at: n.created_at,
          label: 'Note added',
          detail: (n.note ?? '').slice(0, 140),
          candidateId: null,
        })),
        ...statusLog.map((s: any) => ({
          id: `status-${s.id}`, kind: 'status' as const, at: s.created_at,
          label: `Person status: ${s.from_status ?? '—'} → ${s.to_status}`,
          detail: s.triggered_by ?? null,
          candidateId: s.entity_id ?? null,
        })),
      ];
      merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      return merged.slice(0, limit);
    },
  });

  return (
    <div className="rounded-xl border border-card-border bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-card-border flex items-center gap-2">
        <History className="h-4 w-4 text-emerald" />
        <h3 className="text-sm font-semibold text-emerald-dark font-display">Recent Activity</h3>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
      ) : data.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">No activity yet.</div>
      ) : (
        <div className="divide-y divide-card-border">
          {data.map((row) => {
            const Icon = row.kind === 'stage' ? ArrowRight : row.kind === 'note' ? FileText : Calendar;
            const interactive = !!row.candidateId;
            const handleOpen = () => { if (row.candidateId) navigate(`/candidates/${row.candidateId}`); };
            return (
              <div
                key={row.id}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                onClick={interactive ? handleOpen : undefined}
                onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(); } } : undefined}
                className={`px-4 py-2.5 flex items-start gap-2.5 transition-colors ${interactive ? 'hover:bg-emerald-light/30 cursor-pointer' : ''}`}
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">{row.label}</p>
                  {row.detail && (
                    <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">{row.detail}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    {format(new Date(row.at), 'MMM d, h:mm a')}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
