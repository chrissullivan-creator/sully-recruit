import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Loader2, Clock, CheckCircle2, Send, MessageSquare, AlertCircle } from 'lucide-react';

// ---------- Types ----------

interface Step {
  id: string;
  order: number;
  channel: string;
  delay_days?: number;
}

interface Enrollment {
  id: string;
  status: string;
  current_step_order: number | null;
  enrolled_at: string;
  next_step_at: string | null;
  candidate_id: string | null;
  contact_id: string | null;
}

interface Execution {
  id: string;
  enrollment_id: string;
  sequence_step_id: string;
  status: string;
  executed_at: string | null;
}

interface EnrolleeScheduleViewProps {
  sequenceId: string;
  steps: Step[];
  enrollments: Enrollment[];
  executions: Execution[];
}

// ---------- Status helpers ----------

type CellStatus = 'pending' | 'sent' | 'delivered' | 'replied' | 'skipped' | 'failed';

const STATUS_CONFIG: Record<CellStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  pending:   { label: 'Pending',   variant: 'outline',     className: 'border-muted-foreground/40 text-muted-foreground' },
  sent:      { label: 'Sent',      variant: 'secondary',   className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  delivered: { label: 'Delivered', variant: 'secondary',   className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  replied:   { label: 'Replied',   variant: 'default',     className: 'bg-primary/15 text-primary border-primary/30' },
  skipped:   { label: 'Skipped',   variant: 'outline',     className: 'border-muted-foreground/30 text-muted-foreground/60' },
  failed:    { label: 'Failed',    variant: 'destructive' },
};

function normalizeStatus(raw: string): CellStatus {
  const s = raw.toLowerCase();
  if (s === 'replied') return 'replied';
  if (['delivered', 'opened', 'clicked'].includes(s)) return 'delivered';
  if (s === 'sent') return 'sent';
  if (s === 'skipped') return 'skipped';
  if (['failed', 'bounced'].includes(s)) return 'failed';
  return 'pending';
}

function StatusBadge({ status }: { status: CellStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <Badge variant={config.variant} className={cn('text-[10px] px-1.5 py-0', config.className)}>
      {config.label}
    </Badge>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- Component ----------

export function EnrolleeScheduleView({
  sequenceId,
  steps,
  enrollments,
  executions,
}: EnrolleeScheduleViewProps) {
  // Collect unique candidate/contact IDs to fetch names
  const candidateIds = useMemo(
    () => [...new Set(enrollments.map((e) => e.candidate_id).filter(Boolean))] as string[],
    [enrollments],
  );
  const contactIds = useMemo(
    () => [...new Set(enrollments.map((e) => e.contact_id).filter(Boolean))] as string[],
    [enrollments],
  );

  const { data: candidateNames = {} } = useQuery({
    queryKey: ['enrollee_candidates', candidateIds],
    queryFn: async () => {
      if (candidateIds.length === 0) return {};
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name')
        .in('id', candidateIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((c: { id: string; name: string | null }) => {
        map[c.id] = c.name ?? 'Unnamed';
      });
      return map;
    },
    enabled: candidateIds.length > 0,
  });

  const { data: contactNames = {} } = useQuery({
    queryKey: ['enrollee_contacts', contactIds],
    queryFn: async () => {
      if (contactIds.length === 0) return {};
      const { data, error } = await supabase
        .from('contacts')
        .select('id, first_name, last_name')
        .in('id', contactIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      (data ?? []).forEach((c: { id: string; first_name: string | null; last_name: string | null }) => {
        map[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed';
      });
      return map;
    },
    enabled: contactIds.length > 0,
  });

  // Pre-sort steps and build lookup maps
  const sortedSteps = useMemo(() => [...steps].sort((a, b) => a.order - b.order), [steps]);

  // Cumulative delay per step (in ms) for scheduling estimates
  const cumulativeDelays = useMemo(() => {
    let cumulative = 0;
    return sortedSteps.map((step) => {
      cumulative += (step.delay_days ?? 0) * 86400000;
      return cumulative;
    });
  }, [sortedSteps]);

  // Execution lookup: enrollmentId -> stepId -> execution
  const execMap = useMemo(() => {
    const m = new Map<string, Map<string, Execution>>();
    executions.forEach((ex) => {
      if (!m.has(ex.enrollment_id)) m.set(ex.enrollment_id, new Map());
      m.get(ex.enrollment_id)!.set(ex.sequence_step_id, ex);
    });
    return m;
  }, [executions]);

  const getEnrolleeName = (enrollment: Enrollment): string => {
    if (enrollment.candidate_id && candidateNames[enrollment.candidate_id]) {
      return candidateNames[enrollment.candidate_id];
    }
    if (enrollment.contact_id && contactNames[enrollment.contact_id]) {
      return contactNames[enrollment.contact_id];
    }
    return 'Unknown';
  };

  if (enrollments.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No enrollees yet. Enroll candidates to see the schedule.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm min-w-[600px]">
        <thead className="table-header-green">
          <tr>
            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide sticky left-0 bg-[#0B4F2F] z-10">
              Enrollee
            </th>
            <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Status
            </th>
            {sortedSteps.map((step) => (
              <th
                key={step.id}
                className="text-center px-3 py-2.5 text-xs font-medium text-muted-foreground uppercase tracking-wide"
              >
                <div>Step {step.order}</div>
                <div className="text-[10px] normal-case font-normal capitalize">{step.channel}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {enrollments.map((enrollment) => {
            const enrolleeExecs = execMap.get(enrollment.id);
            return (
              <tr key={enrollment.id} className="hover:bg-muted/50 transition-colors">
                {/* Enrollee name */}
                <td className="px-4 py-2.5 font-medium text-foreground whitespace-nowrap sticky left-0 bg-card z-10">
                  {getEnrolleeName(enrollment)}
                </td>

                {/* Enrollment status */}
                <td className="px-3 py-2.5">
                  <Badge
                    variant={enrollment.status === 'active' ? 'default' : 'secondary'}
                    className={cn(
                      'text-[10px] capitalize',
                      enrollment.status === 'completed' && 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
                      enrollment.status === 'paused' && 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
                    )}
                  >
                    {enrollment.status}
                  </Badge>
                </td>

                {/* Per-step cells */}
                {sortedSteps.map((step, idx) => {
                  const exec = enrolleeExecs?.get(step.id);
                  const scheduledTime = new Date(
                    new Date(enrollment.enrolled_at).getTime() + cumulativeDelays[idx],
                  );
                  const cellStatus: CellStatus = exec
                    ? normalizeStatus(exec.status)
                    : step.order <= (enrollment.current_step_order ?? 0)
                      ? 'pending'
                      : 'pending';

                  return (
                    <td key={step.id} className="px-3 py-2.5 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <StatusBadge status={exec ? normalizeStatus(exec.status) : 'pending'} />
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                          {exec?.executed_at
                            ? formatDate(exec.executed_at)
                            : formatDate(scheduledTime.toISOString())}
                        </span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default EnrolleeScheduleView;
