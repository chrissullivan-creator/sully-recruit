// Canonical pipeline funnel — single source of truth for stage labels and groupings.
// Per the Send Outs / Job Detail spec, the canonical stage list is:
//   pitch → ready_to_send → submitted → interview_round_1 → interview_round_2_plus
//   → offer → placed → withdrawn
//
// Existing data uses synonym values (sent, send_out, interviewing, etc.) — the
// stageToCanonical() mapper normalises them so the UI can group cleanly.
// Rejected rows fold into withdrawn for now (final-exit lane).

export type CanonicalStage =
  | 'pitch'
  | 'ready_to_send'
  | 'submitted'
  | 'interview_round_1'
  | 'interview_round_2_plus'
  | 'offer'
  | 'placed'
  | 'withdrawn';

export interface CanonicalStageConfig {
  key: CanonicalStage;
  label: string;
  shortLabel: string;
  pipelineStageValues: string[];
  /** Tailwind classes for the stage chip / dot. Gold for offer, emerald for placed. */
  color: string;
  dotColor: string;
}

export const CANONICAL_PIPELINE: CanonicalStageConfig[] = [
  {
    key: 'pitch',
    label: 'Pitch',
    shortLabel: 'Pitch',
    pipelineStageValues: ['pitch', 'pitched', 'new'],
    color: 'bg-stage-warm/10 text-stage-warm border-stage-warm/30',
    dotColor: 'bg-stage-warm',
  },
  {
    key: 'ready_to_send',
    label: 'Ready to Send',
    shortLabel: 'Ready',
    pipelineStageValues: ['ready_to_send', 'send_out', 'sendout'],
    color: 'bg-yellow-600/10 text-yellow-700 border-yellow-600/30',
    dotColor: 'bg-yellow-600',
  },
  {
    key: 'submitted',
    label: 'Submitted',
    shortLabel: 'Submitted',
    pipelineStageValues: ['submitted', 'sent'],
    color: 'bg-purple-600/10 text-purple-700 border-purple-600/30',
    dotColor: 'bg-purple-600',
  },
  {
    key: 'interview_round_1',
    label: 'Interview R1',
    shortLabel: 'R1',
    pipelineStageValues: ['interview_round_1', 'interview', 'interviewing'],
    color: 'bg-emerald/10 text-emerald border-emerald/30',
    dotColor: 'bg-emerald',
  },
  {
    key: 'interview_round_2_plus',
    label: 'Interview R2+',
    shortLabel: 'R2+',
    pipelineStageValues: ['interview_round_2_plus'],
    color: 'bg-emerald-dark/10 text-emerald-dark border-emerald-dark/30',
    dotColor: 'bg-emerald-dark',
  },
  {
    key: 'offer',
    label: 'Offer',
    shortLabel: 'Offer',
    pipelineStageValues: ['offer'],
    // Offer is gold per spec — premium UI moment.
    color: 'bg-gold/10 text-gold-deep border-gold/40',
    dotColor: 'bg-gold',
  },
  {
    key: 'placed',
    label: 'Placed',
    shortLabel: 'Placed',
    pipelineStageValues: ['placed'],
    color: 'bg-emerald/15 text-emerald-dark border-emerald/40',
    dotColor: 'bg-emerald',
  },
  {
    key: 'withdrawn',
    label: 'Withdrawn',
    shortLabel: 'Withdrawn',
    pipelineStageValues: ['withdrawn', 'withdrew', 'rejected', 'declined'],
    color: 'bg-muted text-muted-foreground border-border',
    dotColor: 'bg-muted-foreground',
  },
];

const STAGE_TO_CANONICAL: Record<string, CanonicalStage> = (() => {
  const map: Record<string, CanonicalStage> = {};
  for (const s of CANONICAL_PIPELINE) {
    for (const v of s.pipelineStageValues) map[v] = s.key;
  }
  return map;
})();

export function stageToCanonical(value: string | null | undefined): CanonicalStage | null {
  if (!value) return null;
  return STAGE_TO_CANONICAL[value] ?? null;
}

export function canonicalConfig(key: CanonicalStage): CanonicalStageConfig {
  return CANONICAL_PIPELINE.find((s) => s.key === key)!;
}

/** Order index of a stage (0-based) — useful for "advance" / "back" buttons. */
export function stageOrder(key: CanonicalStage): number {
  return CANONICAL_PIPELINE.findIndex((s) => s.key === key);
}

export function nextStage(key: CanonicalStage): CanonicalStage | null {
  const i = stageOrder(key);
  if (i < 0 || i >= CANONICAL_PIPELINE.length - 1) return null;
  return CANONICAL_PIPELINE[i + 1].key;
}

export function prevStage(key: CanonicalStage): CanonicalStage | null {
  const i = stageOrder(key);
  if (i <= 0) return null;
  return CANONICAL_PIPELINE[i - 1].key;
}

/** Days between a timestamp and now. Returns 0 if invalid. */
export function daysSince(ts: string | null | undefined): number {
  if (!ts) return 0;
  const ms = Date.now() - new Date(ts).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}
