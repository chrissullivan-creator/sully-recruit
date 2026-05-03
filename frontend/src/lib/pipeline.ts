// Canonical pipeline funnel — single source of truth for stage labels and groupings.
// Matches the 6 event tables (pitches, send_outs, submissions, interviews, placements,
// rejections) that useDashboardMetrics counts. Use this everywhere a pipeline funnel
// renders so the dashboard ties to per-job and per-candidate views.
//
// candidate_jobs.pipeline_stage allows multiple synonym values per canonical stage
// (e.g. "pitch" and "pitched" both mean Pitches). Map them with stageToCanonical().

export type CanonicalStage =
  | 'pitches'
  | 'send_outs'
  | 'submissions'
  | 'interviews'
  | 'placements'
  | 'rejections';

export interface CanonicalStageConfig {
  key: CanonicalStage;
  label: string;
  shortLabel: string;
  table: string;
  pipelineStageValues: string[];
  color: string;
}

export const CANONICAL_PIPELINE: CanonicalStageConfig[] = [
  {
    key: 'pitches',
    label: 'Pitches',
    shortLabel: 'Pitch',
    table: 'pitches',
    pipelineStageValues: ['pitch', 'pitched'],
    color: 'bg-stage-warm/15 text-stage-warm border-stage-warm/20',
  },
  {
    key: 'send_outs',
    label: 'Send Outs',
    shortLabel: 'Send Out',
    table: 'send_outs',
    pipelineStageValues: ['sendout', 'sent', 'ready_to_send'],
    color: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/20',
  },
  {
    key: 'submissions',
    label: 'Submissions',
    shortLabel: 'Submission',
    table: 'submissions',
    pipelineStageValues: ['submitted'],
    color: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  },
  {
    key: 'interviews',
    label: 'Interviews',
    shortLabel: 'Interview',
    table: 'interviews',
    pipelineStageValues: ['interview', 'interviewing'],
    color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  },
  {
    key: 'placements',
    label: 'Placements',
    shortLabel: 'Placement',
    table: 'placements',
    pipelineStageValues: ['placed'],
    color: 'bg-green-600/15 text-green-500 border-green-600/30',
  },
  {
    key: 'rejections',
    label: 'Rejections',
    shortLabel: 'Rejection',
    table: 'rejections',
    pipelineStageValues: ['rejected', 'withdrew', 'withdrawn'],
    color: 'bg-red-500/15 text-red-400 border-red-500/20',
  },
];

const STAGE_TO_CANONICAL: Record<string, CanonicalStage> = (() => {
  const map: Record<string, CanonicalStage> = {};
  for (const s of CANONICAL_PIPELINE) {
    for (const v of s.pipelineStageValues) map[v] = s.key;
  }
  return map;
})();

// Map a candidate_jobs.pipeline_stage value to the canonical funnel key (or null
// if the stage is pre-funnel like "new" or "reached_out").
export function stageToCanonical(pipelineStage: string | null | undefined): CanonicalStage | null {
  if (!pipelineStage) return null;
  return STAGE_TO_CANONICAL[pipelineStage] ?? null;
}

export function canonicalConfig(key: CanonicalStage): CanonicalStageConfig {
  return CANONICAL_PIPELINE.find((s) => s.key === key)!;
}
