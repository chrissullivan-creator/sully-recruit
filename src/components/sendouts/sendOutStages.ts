export const SEND_OUT_STAGES = [
  'send_out',
  'submitted',
  'interviewing',
  'offer',
  'placed',
  'rejected',
  'withdrawn',
] as const;

export type SendOutStage = (typeof SEND_OUT_STAGES)[number];

export const STAGE_LABEL: Record<SendOutStage, string> = {
  send_out:     'Send Out',
  submitted:    'Submitted',
  interviewing: 'Interviewing',
  offer:        'Offer',
  placed:       'Placed',
  rejected:     'Rejected',
  withdrawn:    'Withdrawn',
};

// Emerald / gold brand palette with exit-lane contrast.
export const STAGE_BADGE: Record<SendOutStage, string> = {
  send_out:     'bg-slate-100 text-slate-700 border-slate-200',
  submitted:    'bg-blue-100 text-blue-700 border-blue-200',
  interviewing: 'bg-amber-100 text-amber-700 border-amber-200',
  offer:        'bg-gold/15 text-gold border-gold/25',
  placed:       'bg-emerald-600 text-white border-emerald-700',
  rejected:     'bg-red-100 text-red-700 border-red-200',
  withdrawn:    'bg-muted text-muted-foreground border-border',
};

export const STAGE_COLUMN_ACCENT: Record<SendOutStage, string> = {
  send_out:     'border-t-slate-400',
  submitted:    'border-t-blue-500',
  interviewing: 'border-t-amber-500',
  offer:        'border-t-gold',
  placed:       'border-t-emerald-600',
  rejected:     'border-t-red-500',
  withdrawn:    'border-t-muted-foreground',
};

export function isValidStage(s: string | null | undefined): s is SendOutStage {
  return !!s && (SEND_OUT_STAGES as readonly string[]).includes(s);
}

export function stageLabel(s: string | null | undefined): string {
  if (isValidStage(s)) return STAGE_LABEL[s];
  return s || '—';
}
