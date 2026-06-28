import { useQuery } from '@tanstack/react-query';
import { History, ArrowRight, PencilLine } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { SectionCard } from '@/components/shared/SectionCard';
import { EmptyState } from '@/components/shared/EmptyState';

interface CandidateHistoryTabProps {
  candidateId: string;
}

interface HistoryRow {
  id: string;
  kind: 'status' | 'field';
  at: string;
  label: string;
  detail: string | null;
}

const prettyField = (f: string) => f.replace(/_/g, ' ');

/**
 * History tab — the profile / field change log for a person. Unions
 * status_change_log (status transitions) with audit_log (field-level edits to
 * the people/candidates row). Read-only; this log *is* the History tab.
 */
export function CandidateHistoryTab({ candidateId }: CandidateHistoryTabProps) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['candidate_history', candidateId],
    enabled: !!candidateId,
    queryFn: async () => {
      const [statusRes, auditRes] = await Promise.all([
        supabase
          .from('status_change_log')
          .select('id, from_status, to_status, created_at, triggered_by')
          .eq('entity_type', 'candidate')
          .eq('entity_id', candidateId)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('audit_log')
          .select('id, action, changed, at, actor_email, table_name')
          .eq('row_id', candidateId)
          .in('table_name', ['people', 'candidates'])
          .order('at', { ascending: false })
          .limit(100),
      ]);

      const rows: HistoryRow[] = [
        ...((statusRes.data ?? []).map((s: any) => ({
          id: `status-${s.id}`,
          kind: 'status' as const,
          at: s.created_at,
          label: `Status: ${s.from_status ?? '—'} → ${s.to_status}`,
          detail: s.triggered_by ?? null,
        }))),
        ...((auditRes.data ?? []).map((a: any) => {
          const changed = a.changed && typeof a.changed === 'object' ? Object.keys(a.changed) : [];
          const fields = changed.slice(0, 6).map(prettyField).join(', ');
          return {
            id: `audit-${a.id}`,
            kind: 'field' as const,
            at: a.at,
            label: changed.length
              ? `Updated ${fields}${changed.length > 6 ? ` +${changed.length - 6} more` : ''}`
              : `${a.action} record`,
            detail: a.actor_email ?? null,
          };
        })),
      ];
      rows.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
      return rows;
    },
  });

  return (
    <SectionCard title="History" icon={<History className="h-4 w-4" />}>
      {isLoading ? (
        <p className="py-6 text-sm text-muted-foreground">Loading…</p>
      ) : data.length === 0 ? (
        <EmptyState icon={History} title="No changes recorded yet" className="py-8" />
      ) : (
        <ul className="divide-y divide-card-border">
          {data.map((row) => {
            const Icon = row.kind === 'status' ? ArrowRight : PencilLine;
            return (
              <li key={row.id} className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{row.label}</p>
                  {row.detail && <p className="text-xs text-muted-foreground truncate">{row.detail}</p>}
                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                    {row.at ? format(new Date(row.at), 'MMM d, yyyy h:mm a') : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
