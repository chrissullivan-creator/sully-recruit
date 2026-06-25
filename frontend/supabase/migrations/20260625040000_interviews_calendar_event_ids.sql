-- Per-calendar Outlook event ids for an interview's non-blocking marker. We drop
-- the event on more than one mailbox (the owner + always Chris), so a single
-- calendar_event_id isn't enough — keep [{email,id}] here. calendar_event_id
-- stays as the primary (owner's) for back-compat.
alter table public.interviews
  add column if not exists calendar_event_ids jsonb not null default '[]'::jsonb;
