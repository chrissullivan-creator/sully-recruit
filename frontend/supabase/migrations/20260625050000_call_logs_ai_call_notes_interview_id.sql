-- Tie a recorded debrief call to a specific interview. Nullable so all existing
-- candidate/contact calls are unaffected; ON DELETE SET NULL so removing an
-- interview never deletes its call history.
alter table public.call_logs
  add column if not exists interview_id uuid references public.interviews(id) on delete set null;
alter table public.ai_call_notes
  add column if not exists interview_id uuid references public.interviews(id) on delete set null;
create index if not exists call_logs_interview_id_idx    on public.call_logs(interview_id);
create index if not exists ai_call_notes_interview_id_idx on public.ai_call_notes(interview_id);
