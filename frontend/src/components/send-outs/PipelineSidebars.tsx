import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Clock, CalendarCheck, ChevronRight, TrendingUp, Building2, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard } from '@/components/shared/SectionCard';
import { PersonAvatar } from '@/components/shared/PersonAvatar';
import { type SendOutRow } from '@/lib/queries/send-outs';
import { type PipelineStats } from '@/lib/send-out-insights';
import { canonicalConfig, stageToCanonical, type CanonicalStage } from '@/lib/pipeline';

/** Bottom three panels of the Send Outs pipeline: what needs action, insights, recent activity. */
export function PipelineSidebars({
  stats, rows, onStageClick,
}: { stats: PipelineStats; rows: SendOutRow[]; onStageClick?: (s: CanonicalStage) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <NeedsAttention stats={stats} onStageClick={onStageClick} />
      <PipelineInsights stats={stats} />
      <ActivityFeed rows={rows} />
    </div>
  );
}

function NeedsAttention({ stats, onStageClick }: { stats: PipelineStats; onStageClick?: (s: CanonicalStage) => void }) {
  const items = [
    {
      n: stats.notContacted.length, color: 'text-stage-hot', bg: 'bg-stage-hot/10', icon: Clock,
      title: 'candidates', sub: "Haven't been contacted in 3+ days", stage: 'pitch' as CanonicalStage,
      show: stats.notContacted.length > 0,
    },
    {
      n: stats.submissionsWaiting.length, color: 'text-stage-warm', bg: 'bg-stage-warm/10', icon: AlertTriangle,
      title: 'submissions', sub: 'Waiting on client feedback', stage: 'submitted' as CanonicalStage,
      show: stats.submissionsWaiting.length > 0,
    },
    {
      n: stats.interviewsThisWeek, color: 'text-info', bg: 'bg-info/10', icon: CalendarCheck,
      title: 'interviews', sub: 'Scheduled this week', stage: 'interview' as CanonicalStage,
      show: stats.interviewsThisWeek > 0,
    },
  ].filter((i) => i.show);

  const total = stats.notContacted.length + stats.submissionsWaiting.length + stats.interviewsThisWeek;

  return (
    <SectionCard
      title="Needs your attention"
      actions={total > 0 ? <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-stage-hot/10 px-1.5 text-[11px] font-semibold text-stage-hot">{total}</span> : undefined}
      bodyClassName="p-3 space-y-2"
    >
      {items.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">All clear — nothing needs follow-up.</p>
      ) : items.map((it) => (
        <button
          key={it.title}
          onClick={onStageClick ? () => onStageClick(it.stage) : undefined}
          className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/30"
        >
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', it.bg)}>
            <it.icon className={cn('h-4 w-4', it.color)} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground"><span className={it.color}>{it.n}</span> {it.title}</p>
            <p className="text-[11px] text-muted-foreground truncate">{it.sub}</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </SectionCard>
  );
}

function InsightRow({ icon: Icon, label, value, valueClass }: { icon: any; label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <span className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <span className={cn('text-sm font-semibold tabular-nums shrink-0', valueClass ?? 'text-foreground')}>{value}</span>
    </div>
  );
}

function PipelineInsights({ stats }: { stats: PipelineStats }) {
  return (
    <SectionCard title="Pipeline insights" bodyClassName="px-5 py-2 divide-y divide-card-border">
      <InsightRow icon={Clock} label="Avg. time in submission"
        value={stats.avgDaysSubmission != null ? `${stats.avgDaysSubmission} days` : '—'} />
      <InsightRow icon={Clock} label="Avg. time in interview"
        value={stats.avgDaysInterview != null ? `${stats.avgDaysInterview} days` : '—'} />
      <InsightRow icon={Building2} label="Top client"
        value={stats.topClient ? `${stats.topClient.name}` : '—'} valueClass="text-primary" />
      <InsightRow icon={TrendingUp} label="Active candidates" value={String(stats.active)} />
      <InsightRow icon={CalendarCheck} label="Placement rate" value={`${stats.placementRate}%`} valueClass="text-accent" />
    </SectionCard>
  );
}

function ActivityFeed({ rows }: { rows: SendOutRow[] }) {
  // rows arrive newest-first (query orders by updated_at desc).
  const recent = rows
    .filter((r) => r.updated_at)
    .slice(0, 6);

  return (
    <SectionCard title="Activity feed" icon={<Activity className="h-4 w-4" />} bodyClassName="p-3 space-y-1">
      {recent.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">No recent activity.</p>
      ) : recent.map((r) => {
        const name = r.candidate?.full_name ?? '—';
        const cfg = canonicalConfig(stageToCanonical(r.stage));
        return (
          <div key={r.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <PersonAvatar name={name} src={r.candidate?.avatar_url} size="xs" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-foreground truncate">
                <span className="font-medium">{name}</span> moved to <span className="font-medium">{cfg.label}</span>
              </p>
              {r.job?.title && <p className="text-[11px] text-muted-foreground truncate">{r.job.title}</p>}
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatDistanceToNow(new Date(r.updated_at!), { addSuffix: false })}
            </span>
          </div>
        );
      })}
    </SectionCard>
  );
}
