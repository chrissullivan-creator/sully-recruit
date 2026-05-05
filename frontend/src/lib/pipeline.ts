// Canonical pipeline funnel — single source of truth for stage labels and groupings.
//
// Per the firm's terminology (May 2026), the pipeline is:
//   Pitch       — candidate needs to be pitched the role
//   Send Out    — candidate is ready to go (queue waiting to go to client)
//   Submission  — candidate has been sent to the client
//   Interview   — candidate is in the client's interview process
//                 (round number captured separately in send_outs.interview_round)
//   Offer       — client has extended an offer
//   Withdrawn   — terminal exit, with optional withdrawn_reason text
//
// `placed` is kept as a 7th stage value so historical "win" rows still
// resolve, but it doesn't show up on the main funnel tiles — Placed is
// the success outcome after Offer, surfaced on the Send Outs page in
// its own collapsible section + on Reports.
//
// Existing data uses synonym values (sent, send_out, interview_round_1,
// etc.) — stageToCanonical() normalises them so the UI groups cleanly.

export type CanonicalStage =
  | 'pitch'
  | 'ready_to_send'
  | 'submitted'
  | 'interview'
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
    label: 'Send Out',
    shortLabel: 'Send Out',
    pipelineStageValues: ['ready_to_send', 'send_out', 'sendout'],
    color: 'bg-yellow-600/10 text-yellow-700 border-yellow-600/30',
    dotColor: 'bg-yellow-600',
  },
  {
    key: 'submitted',
    label: 'Submission',
    shortLabel: 'Submission',
    pipelineStageValues: ['submitted', 'sent'],
    color: 'bg-purple-600/10 text-purple-700 border-purple-600/30',
    dotColor: 'bg-purple-600',
  },
  {
    // Single Interview stage — round number lives on send_outs.interview_round
    // (and candidate_jobs.interview_round). Legacy split values
    // ('interview_round_1', 'interview_round_2_plus') were migrated in
    // the May 2026 pipeline_simplification_* migration.
    key: 'interview',
    label: 'Interview',
    shortLabel: 'Interview',
    pipelineStageValues: ['interview', 'interviewing', 'interview_round_1', 'interview_round_2_plus'],
    color: 'bg-emerald/10 text-emerald border-emerald/30',
    dotColor: 'bg-emerald',
  },
  {
    key: 'offer',
    label: 'Offer',
    shortLabel: 'Offer',
    pipelineStageValues: ['offer'],
    color: 'bg-gold/10 text-gold-deep border-gold/40',
    dotColor: 'bg-gold',
  },
  {
    // 'placed' = the success terminal. Kept so existing data resolves
    // and so reports / Send Outs page can show the wins. Not surfaced
    // on the main 6-tile dashboard funnel.
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
    pipelineStageValues: ['withdrawn', 'withdrew', 'rejected', 'declined', 'reject'],
    color: 'bg-muted text-muted-foreground border-border',
    dotColor: 'bg-muted-foreground',
  },
];

/**
 * Stages that show up as funnel tiles on the Dashboard. `placed` is
 * intentionally excluded — it's a success outcome, not a step. Reports
 * + Send Outs page surface it on their own.
 */
export const FUNNEL_STAGES: CanonicalStage[] = [
  'pitch', 'ready_to_send', 'submitted', 'interview', 'offer', 'withdrawn',
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
