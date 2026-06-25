import { useQuery } from '@tanstack/react-query';
import { Award, Users, FileCheck, Calendar } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { stageToCanonical, daysSince, type CanonicalStage } from '@/lib/pipeline';
import { formatComp } from '@/lib/queries/send-outs';

interface QuickStatsProps {
  jobId: string;
  /** Job comp band — used to compute the est. fee. Pass min/max base in cents/dollars. */
  compMin?: number | null;
  compMax?: number | null;
  /** Fee % stored on the job (defaults to 25). */
  feePct?: number | null;
  /** Job created_at — used for "days open". */
  createdAt?: string | null;
  /** Job filled_at / closed_at — when set, "days open" is bounded by it. */
  closedAt?: string | null;
  /** When provided, clicking the Submitted / Interview / Placed rows calls this with the
   *  matching canonical stage so the parent can scroll to / highlight it. */
  onStageClick?: (stage: 'submitted' | 'interview' | 'placed') => void;
}

export function QuickStats({ jobId, compMin, compMax, feePct, createdAt, closedAt, onStageClick }: QuickStatsProps) {
  const { data: rows = [] } = useQuery({
    queryKey: ['job_quick_stats', jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidate_jobs')
        .select('pipeline_stage, max_pipeline_stage')
        .eq('job_id', jobId)
        .is('deleted_at', null);
      if (error) throw error;
      return (data ?? []) as { pipeline_stage: string | null; max_pipeline_stage: string | null }[];
    },
  });

  const total = rows.length;
  // Funnel progression (terminal `withdrawn` excluded — it's an exit, not a step).
  // Rates are cumulative ("reached this stage or beyond"), not "currently parked
  // here": a candidate who advanced past a stage — even one who later withdrew —
  // still counts as having passed through it. We read max_pipeline_stage (the
  // furthest stage ever reached, maintained server-side) rather than the current
  // pipeline_stage, so e.g. a submitted-then-rejected candidate still counts as a
  // submission. `placed` stays on the current stage — it's a live "won" count.
  const PROGRESSION: CanonicalStage[] = ['pitch', 'ready_to_send', 'submitted', 'interview', 'offer', 'placed'];
  const SUBMITTED_IDX = PROGRESSION.indexOf('submitted');
  const INTERVIEW_IDX = PROGRESSION.indexOf('interview');

  let reachedSubmitted = 0, reachedInterview = 0, placed = 0;
  for (const r of rows) {
    const reached = stageToCanonical(r.max_pipeline_stage);
    const idx = reached ? PROGRESSION.indexOf(reached) : -1;
    if (idx >= SUBMITTED_IDX) reachedSubmitted++;
    if (idx >= INTERVIEW_IDX) reachedInterview++;
    if (stageToCanonical(r.pipeline_stage) === 'placed') placed++;
  }
  // Submission rate is of the whole candidate pool; interview rate is the
  // submission→interview conversion (how many of those submitted reached interview).
  const submissionRate = total > 0 ? Math.round((reachedSubmitted / total) * 100) : 0;
  const interviewRate  = reachedSubmitted > 0 ? Math.round((reachedInterview / reachedSubmitted) * 100) : 0;

  const daysOpen = closedAt
    ? Math.max(0, Math.floor((new Date(closedAt).getTime() - new Date(createdAt ?? Date.now()).getTime()) / 86_400_000))
    : daysSince(createdAt);

  // Fee = comp midpoint × fee % (default 25).
  const midpoint = compMin && compMax ? (compMin + compMax) / 2 : (compMin ?? compMax ?? 0);
  const fee = midpoint * ((feePct ?? 25) / 100);

  return (
    <div className="rounded-xl border border-gold/30 overflow-hidden">
      <div className="bg-gradient-to-br from-gold-bg via-gold-light/40 to-white px-4 py-4 border-b border-gold/20">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold/15 text-gold-deep">
            <Award className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-semibold text-gold-deep font-display">Quick Stats</h3>
        </div>
        {fee > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gold-deep/70">Est. Fee</p>
            <p className="text-2xl font-bold text-gold-deep tabular-nums font-display mt-0.5">
              {formatComp(fee)}
            </p>
          </div>
        )}
      </div>

      <div className="bg-white divide-y divide-card-border">
        <StatRow icon={Calendar} label="Days Open"        value={`${daysOpen}d`} />
        <StatRow icon={Users}    label="Total Candidates" value={String(total)} />
        <StatRow icon={FileCheck} label="Submission Rate" value={`${submissionRate}%`} onClick={onStageClick ? () => onStageClick('submitted') : undefined} />
        <StatRow icon={Calendar} label="Interview Rate"   value={`${interviewRate}%`} onClick={onStageClick ? () => onStageClick('interview') : undefined} />
        {placed > 0 && <StatRow icon={Award} label="Placed" value={String(placed)} gold onClick={onStageClick ? () => onStageClick('placed') : undefined} />}
      </div>
    </div>
  );
}

function StatRow({
  icon: Icon, label, value, gold, onClick,
}: { icon: any; label: string; value: string; gold?: boolean; onClick?: () => void }) {
  const interactive = !!onClick;
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      className={`flex items-center justify-between px-4 py-2.5 ${interactive ? 'cursor-pointer hover:bg-emerald-light/30 transition-colors' : ''}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>
      <span className={`text-sm font-semibold tabular-nums ${gold ? 'text-gold-deep' : 'text-emerald-dark'}`}>
        {value}
      </span>
    </div>
  );
}
