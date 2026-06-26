import { canonicalConfig, type CanonicalStage } from '@/lib/pipeline';
import { cn } from '@/lib/utils';

/**
 * Rolled-up candidate-pipeline stage for a job (Pitch → Send Out →
 * Submission → Interview → Offer → Placed). Distinct from the job's
 * business-development status (Lead / Hot / Filled …) — this reflects how
 * far the job's candidates have actually progressed, derived in
 * useJobPipelineStages / useJobPipelineStage. Renders nothing when no
 * candidate has entered the pipeline yet.
 */
export function JobPipelineStageBadge({
  stage,
  className,
  showLabel = false,
}: {
  stage: CanonicalStage | null | undefined;
  className?: string;
  /** Prefix the chip with a muted "Pipeline" caption (used on the list). */
  showLabel?: boolean;
}) {
  if (!stage) {
    return showLabel ? <span className="text-xs text-muted-foreground">—</span> : null;
  }
  const cfg = canonicalConfig(stage);
  return (
    <span className="inline-flex items-center gap-1.5">
      {showLabel && (
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Pipeline</span>
      )}
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
          cfg.color,
          className,
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dotColor)} />
        {cfg.shortLabel}
      </span>
    </span>
  );
}
