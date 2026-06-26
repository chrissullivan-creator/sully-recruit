import { useNavigate } from 'react-router-dom';
import { useCommandCenter, type JoeRec } from '@/hooks/useCommandCenter';
import { PersonAvatar } from '@/components/shared/PersonAvatar';
import { CompanyLogo } from '@/components/shared/CompanyLogo';
import { cn } from '@/lib/utils';
import {
  Phone, CalendarClock, Award, Trophy, Briefcase, Timer,
  Flame, TrendingDown, BellRing, AlertTriangle, Sparkles, TrendingUp,
  ArrowUpRight, ChevronRight,
} from 'lucide-react';

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

// Compact money: 525000 → $525k, 1500000 → $1.5M.
const money = (n?: number | null) => {
  if (n == null) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
};

const joeHref = (r: JoeRec) =>
  r.entity_type === 'candidate' ? `/candidates/${r.entity_id}`
  : r.entity_type === 'client' ? `/contacts/${r.entity_id}`
  : r.entity_type === 'job' ? `/jobs/${r.entity_id}`
  : '/today';

// ── KPI tile: white card, emerald number, minimal icon ──────────────────
function Kpi({
  label, value, sub, icon, onClick, loading,
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ReactNode; onClick?: () => void; loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex flex-col items-start rounded-2xl border border-border bg-card p-5 text-left',
        'shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
        onClick ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/5 text-primary">
          {icon}
        </span>
        {onClick && <ArrowUpRight className="h-4 w-4 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />}
      </div>
      <p className="mt-4 text-3xl font-semibold tabular-nums text-primary font-display">
        {loading ? '…' : value}
      </p>
      <p className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground/70">{sub}</p>}
    </button>
  );
}

// ── Signal card: a stat + its top few rows, click-through ───────────────
function Signal({
  title, count, tone, icon, onClickAll, children,
}: {
  title: string; count: number; tone: 'emerald' | 'gold' | 'rose' | 'blue';
  icon: React.ReactNode; onClickAll: () => void; children: React.ReactNode;
}) {
  const toneCls = {
    emerald: 'bg-primary/5 text-primary',
    gold: 'bg-accent/10 text-accent',
    rose: 'bg-destructive/10 text-destructive',
    blue: 'bg-info/10 text-info',
  }[tone];
  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', toneCls)}>{icon}</span>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        <span className="text-2xl font-semibold tabular-nums text-foreground font-display">{count}</span>
      </div>
      <div className="mt-3 flex-1 space-y-0.5">{children}</div>
      <button
        onClick={onClickAll}
        className="mt-3 flex items-center gap-1 self-start text-xs font-medium text-primary hover:underline"
      >
        View all <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

function MiniRow({ primary, secondary, badge, leading, onClick }: {
  primary: string; secondary?: string; badge?: React.ReactNode; leading?: React.ReactNode; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{primary}</span>
        {secondary && <span className="block truncate text-xs text-muted-foreground">{secondary}</span>}
      </span>
      {badge}
    </button>
  );
}

function SentimentDot({ s }: { s: string | null }) {
  if (!s) return null;
  const positive = s === 'positive' || s === 'interested' || s === 'booked_meeting';
  const negative = s === 'negative' || s === 'not_interested';
  return (
    <span className={cn(
      'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize',
      positive ? 'bg-primary/10 text-primary' : negative ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
    )}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}

export function CommandCenter({ displayName }: { displayName: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useCommandCenter();
  const d = data;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <span className="text-xs font-semibold uppercase tracking-widest text-accent">Command Center</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-foreground font-display">{getGreeting()}, {displayName}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Here's where your desk stands this morning.</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Calls Today"   value={d?.calls_today ?? 0}      icon={<Phone className="h-4 w-4" />}        loading={isLoading} onClick={() => navigate('/communication-hub')} />
        <Kpi label="Interviews"    value={d?.interviews_next7 ?? 0} sub="next 7 days" icon={<CalendarClock className="h-4 w-4" />} loading={isLoading} onClick={() => navigate('/interviews')} />
        <Kpi label="Offers Out"    value={d?.offers_out ?? 0}       icon={<Award className="h-4 w-4" />}        loading={isLoading} onClick={() => navigate('/send-outs?stage=offer')} />
        <Kpi label="Placements"    value={d?.placements_mtd ?? 0}   sub="this month" icon={<Trophy className="h-4 w-4" />}  loading={isLoading} onClick={() => navigate('/reports')} />
        <Kpi label="Open Searches" value={d?.open_searches ?? 0}    icon={<Briefcase className="h-4 w-4" />}    loading={isLoading} onClick={() => navigate('/jobs')} />
        <Kpi label="Avg Time to Fill" value={d?.avg_days_to_fill != null ? `${d.avg_days_to_fill}d` : '—'} icon={<Timer className="h-4 w-4" />} loading={isLoading} onClick={() => navigate('/reports')} />
      </div>

      {/* Intelligence grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Left: today's focus — 2×2 signals */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:col-span-2">
          <Signal title="Ready to move" count={d?.ready_to_move_count ?? 0} tone="emerald" icon={<Flame className="h-4 w-4" />} onClickAll={() => navigate('/people?status=engaged')}>
            {(d?.ready_to_move ?? []).slice(0, 4).map((p) => (
              <MiniRow key={p.id} leading={<PersonAvatar name={p.name} src={p.avatar} size="sm" />} primary={p.name ?? '—'} secondary={[p.title, p.company].filter(Boolean).join(' · ')} badge={<SentimentDot s={p.sentiment} />} onClick={() => navigate(`/candidates/${p.id}`)} />
            ))}
            {!isLoading && (d?.ready_to_move?.length ?? 0) === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">Nobody flagged right now.</p>}
          </Signal>

          <Signal title="Follow-ups due" count={d?.followups_due ?? 0} tone="blue" icon={<BellRing className="h-4 w-4" />} onClickAll={() => navigate('/tasks')}>
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {(d?.followups_due ?? 0) > 0
                ? `${d?.followups_due} task${d?.followups_due === 1 ? '' : 's'} due or overdue. Clear the oldest first.`
                : 'Inbox zero — no follow-ups due.'}
            </p>
            <button onClick={() => navigate('/tasks')} className="mt-1 flex items-center gap-1 rounded-lg bg-info/5 px-2 py-1.5 text-xs font-medium text-info hover:bg-info/10">
              Open To-Do <ChevronRight className="h-3 w-3" />
            </button>
          </Signal>

          <Signal title="Below market pay" count={d?.below_market_count ?? 0} tone="gold" icon={<TrendingDown className="h-4 w-4" />} onClickAll={() => navigate('/people')}>
            {(d?.below_market ?? []).slice(0, 4).map((p) => (
              <MiniRow key={p.id} leading={<PersonAvatar name={p.name} src={p.avatar} size="sm" />} primary={p.name ?? '—'} secondary={[p.title, p.company].filter(Boolean).join(' · ')}
                badge={<span className="shrink-0 text-xs font-semibold tabular-nums text-accent">{money(p.cur)}→{money(p.tgt)}</span>}
                onClick={() => navigate(`/candidates/${p.id}`)} />
            ))}
            {!isLoading && (d?.below_market?.length ?? 0) === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No comp gaps flagged.</p>}
          </Signal>

          <Signal title="Searches at risk" count={d?.searches_at_risk_count ?? 0} tone="rose" icon={<AlertTriangle className="h-4 w-4" />} onClickAll={() => navigate('/jobs')}>
            {(d?.at_risk ?? []).slice(0, 4).map((j) => (
              <MiniRow key={j.id} leading={<CompanyLogo name={j.company ?? '—'} domain={j.company_domain} logoUrl={j.company_logo} size="sm" />} primary={j.title ?? '—'} secondary={j.company ?? undefined}
                badge={<span className="shrink-0 text-[10px] font-medium text-destructive">stale</span>}
                onClick={() => navigate(`/jobs/${j.id}`)} />
            ))}
            {!isLoading && (d?.at_risk?.length ?? 0) === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">Every search has recent activity.</p>}
          </Signal>
        </div>

        {/* Right: Ask Joe + forecast */}
        <div className="space-y-5">
          {/* Ask Joe recommendations — premium */}
          <div className="rounded-2xl border border-accent/30 bg-gradient-to-b from-accent/[0.06] to-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent"><Sparkles className="h-4 w-4" /></span>
                <h3 className="text-sm font-semibold text-foreground">Ask Joe says</h3>
              </div>
              <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">AI</span>
            </div>
            <div className="mt-3 space-y-2">
              {(d?.joe_recs ?? []).slice(0, 5).map((r) => (
                <button key={r.id} onClick={() => navigate(joeHref(r))} className="block w-full rounded-xl border border-border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-md">
                  <p className="text-sm font-medium leading-snug text-foreground">{r.headline}</p>
                  {r.rationale && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.rationale}</p>}
                </button>
              ))}
              {!isLoading && (d?.joe_recs?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">No recommendations yet today.</p>}
            </div>
            <button onClick={() => navigate('/today')} className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
              Open Today's brief <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Revenue & forecast */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/5 text-primary"><TrendingUp className="h-4 w-4" /></span>
              <h3 className="text-sm font-semibold text-foreground">Revenue</h3>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums text-primary font-display">{money(d?.revenue_mtd)}</p>
                <p className="text-xs text-muted-foreground">Booked this month</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums text-accent font-display">{money(d?.forecast_pipeline)}</p>
                <p className="text-xs text-muted-foreground">In offers ({d?.offers_out ?? 0})</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
