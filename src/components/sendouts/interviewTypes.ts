export const INTERVIEW_TYPES = [
  'phone_screen',
  'recruiter_screen',
  'hiring_manager',
  'technical',
  'onsite',
  'panel',
  'culture_fit',
  'final',
] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const INTERVIEW_TYPE_LABEL: Record<InterviewType, string> = {
  phone_screen:     'Phone Screen',
  recruiter_screen: 'Recruiter Screen',
  hiring_manager:   'Hiring Manager',
  technical:        'Technical',
  onsite:           'Onsite',
  panel:            'Panel',
  culture_fit:      'Culture Fit',
  final:            'Final',
};

export const INTERVIEW_OUTCOMES = [
  'pending',
  'passed',
  'rejected',
  'no_show',
  'cancelled',
] as const;

export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export const INTERVIEW_OUTCOME_LABEL: Record<InterviewOutcome, string> = {
  pending:   'Pending',
  passed:    'Passed',
  rejected:  'Rejected',
  no_show:   'No Show',
  cancelled: 'Cancelled',
};

export const INTERVIEW_OUTCOME_BADGE: Record<InterviewOutcome, string> = {
  pending:   'bg-muted text-muted-foreground border-border',
  passed:    'bg-emerald-100 text-emerald-700 border-emerald-200',
  rejected:  'bg-red-100 text-red-700 border-red-200',
  no_show:   'bg-amber-100 text-amber-700 border-amber-200',
  cancelled: 'bg-slate-100 text-slate-700 border-slate-200',
};

// Matches the live `interviews` table shape in Supabase.
export interface InterviewRow {
  id: string;
  send_out_id: string | null;
  candidate_id: string | null;
  job_id: string | null;
  round: number | null;
  interview_type: string | null;
  stage: string;
  scheduled_at: string | null;
  end_at: string | null;
  timezone: string | null;
  location: string | null;
  meeting_link: string | null;
  interviewer_contact_id: string | null;
  interviewer_name: string | null;
  interviewer_title: string | null;
  interviewer_company: string | null;
  additional_interviewers: any;
  calendar_event_id: string | null;
  calendar_event_url: string | null;
  calendar_attendees: any;
  outcome: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  debrief_notes: string | null;
  debrief_at: string | null;
  debrief_source: string | null;
  ai_summary: string | null;
  ai_sentiment: string | null;
  ai_confidence: number | null;
  owner_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}
