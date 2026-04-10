import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Bot, User, Cog } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useProfiles } from '@/hooks/useProfiles';
import { cn } from '@/lib/utils';

interface StageTransitionLogProps {
  entityType: string;
  entityId: string | undefined;
  defaultOpen?: boolean;
  className?: string;
}

interface StageTransitionRow {
  id: string;
  entity_type: string;
  entity_id: string;
  from_stage: string | null;
  to_stage: string;
  moved_by_type: 'human' | 'ai' | 'system' | string;
  moved_by: string | null;
  source: string | null;
  ai_reasoning: string | null;
  created_at: string;
}

export function useStageTransitions(entityType: string, entityId: string | undefined) {
  return useQuery({
    queryKey: ['stage_transitions', entityType, entityId],
    enabled: !!entityId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('stage_transitions')
        .select('*')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as StageTransitionRow[];
    },
  });
}

function MovedByIcon({ type }: { type: string }) {
  if (type === 'ai') return <Bot className="h-3.5 w-3.5 text-gold" />;
  if (type === 'system') return <Cog className="h-3.5 w-3.5 text-muted-foreground" />;
  return <User className="h-3.5 w-3.5 text-emerald-700" />;
}

function prettyStage(s: string | null | undefined) {
  if (!s) return '—';
  return s.replace(/_/g, ' ');
}

export function StageTransitionLog({
  entityType,
  entityId,
  defaultOpen = true,
  className,
}: StageTransitionLogProps) {
  const [open, setOpen] = useState(defaultOpen);
  const { data: rows = [], isLoading } = useStageTransitions(entityType, entityId);
  const { data: profiles = [] } = useProfiles();
  const nameById = Object.fromEntries(profiles.map((p) => [p.id, p.full_name || p.email || '']));

  return (
    <div className={cn('border border-border rounded-md bg-card', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Stage History
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-foreground normal-case tracking-normal">
            {rows.length}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          {isLoading ? (
            <div className="p-3 text-xs text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">No stage changes yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">When</th>
                  <th className="text-left px-3 py-1.5 font-medium">From</th>
                  <th className="text-left px-3 py-1.5 font-medium">To</th>
                  <th className="text-left px-3 py-1.5 font-medium">By</th>
                  <th className="text-left px-3 py-1.5 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border/60 align-top">
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                      {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                    </td>
                    <td className="px-3 py-1.5 capitalize">{prettyStage(row.from_stage)}</td>
                    <td className="px-3 py-1.5 capitalize font-medium">{prettyStage(row.to_stage)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <MovedByIcon type={row.moved_by_type} />
                        <span className="truncate">
                          {row.moved_by_type === 'ai'
                            ? 'Joe (AI)'
                            : row.moved_by_type === 'system'
                            ? 'System'
                            : (row.moved_by && nameById[row.moved_by]) || 'Teammate'}
                        </span>
                      </div>
                      {row.ai_reasoning && (
                        <div className="mt-1 text-[11px] italic text-muted-foreground">{row.ai_reasoning}</div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{row.source || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default StageTransitionLog;
