import { cn } from '@/lib/utils';
import {
  jobStatusMeta,
  jobStatusLabel,
  leadStageMeta,
  leadStageLabel,
} from '@/lib/jobStatus';
import {
  stageToCanonical,
  canonicalConfig,
  type CanonicalStage,
} from '@/lib/pipeline';

/**
 * StatusBadge — the single source for status pills across the redesign.
 *
 * It does NOT invent any colors. Every variant delegates to the canonical
 * helpers that already own the brand/semantic mapping:
 *   - `kind="job"`        → jobStatus.ts  (lead / hot / offer_made / filled / closed_lost)
 *   - `kind="lead-stage"` → jobStatus.ts  (new / contacts_added / reached_out / market_over)
 *   - `kind="pipeline"`   → pipeline.ts   (pitch / send out / submission / interview / offer / placed / rejected)
 *
 * Keeping all status presentation here means a color/label change happens in
 * exactly one place and every list + detail surface stays in lockstep.
 */
export type StatusBadgeKind = 'job' | 'lead-stage' | 'pipeline';

interface StatusBadgeProps {
  kind: StatusBadgeKind;
  /** Raw DB value — jobs.status, jobs.lead_stage, or a pipeline stage value. */
  value?: string | null;
  className?: string;
  /** Optional click (e.g. inline stage edit). Renders as a button when set. */
  onClick?: () => void;
}

const BASE =
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap';

function resolve(kind: StatusBadgeKind, value?: string | null): {
  label: string;
  pillClass: string;
  dotClass?: string;
} {
  if (kind === 'job') {
    const meta = jobStatusMeta(value);
    return {
      label: jobStatusLabel(value),
      pillClass: meta?.pillClass ?? 'bg-muted text-muted-foreground',
      dotClass: meta?.dotClass,
    };
  }
  if (kind === 'lead-stage') {
    const meta = leadStageMeta(value ?? 'new') ?? leadStageMeta('new')!;
    return { label: leadStageLabel(value), pillClass: meta.pillClass };
  }
  // pipeline
  const canonical: CanonicalStage | null = stageToCanonical(value);
  if (!canonical) {
    return { label: (value ?? '—').replace(/_/g, ' '), pillClass: 'bg-muted text-muted-foreground' };
  }
  const cfg = canonicalConfig(canonical);
  // pipeline.ts colors carry a border token; keep them — they're brand tokens.
  return { label: cfg.label, pillClass: cfg.color, dotClass: cfg.dotColor };
}

export function StatusBadge({ kind, value, className, onClick }: StatusBadgeProps) {
  const { label, pillClass, dotClass } = resolve(kind, value);
  const content = (
    <>
      {dotClass && kind !== 'pipeline' && (
        <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
      )}
      {label}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(BASE, pillClass, 'cursor-pointer transition-opacity hover:opacity-80', className)}
      >
        {content}
      </button>
    );
  }

  return <span className={cn(BASE, pillClass, className)}>{content}</span>;
}
