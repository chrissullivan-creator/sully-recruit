-- Submission follow-up cadence. last_follow_up_at starts at the day the
-- candidate was moved to submission (sent_to_client_at); the To-Do's page
-- raises a follow-up reminder 4 business days after it, and a "Log follow-up"
-- button resets it to now() each time the recruiter chases the client.
alter table public.send_outs
  add column if not exists last_follow_up_at timestamptz;

-- Seed currently-submitted rows so the reminder clock starts ticking from the
-- submission date rather than firing immediately for the whole backlog.
update public.send_outs
   set last_follow_up_at = coalesce(sent_to_client_at, updated_at, created_at)
 where last_follow_up_at is null
   and stage in ('submitted', 'sent');

comment on column public.send_outs.last_follow_up_at is
  'Last time the recruiter followed up with the client on this submission. Seeded from sent_to_client_at on submit; reset by the To-Do Log follow-up button. Drives the 4-business-day follow-up reminder.';
