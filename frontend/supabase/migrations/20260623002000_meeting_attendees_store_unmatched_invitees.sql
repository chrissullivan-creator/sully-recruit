-- Let meeting_attendees store ALL calendar invitees, not just the ones whose
-- invite email matched a CRM record. Adds the raw name/email and makes the
-- linked-entity columns nullable so an unmatched invitee (e.g. a candidate
-- invited under an email not on file) is still recorded and can be linked
-- to a profile later from the meeting dialog.
alter table public.meeting_attendees
  add column if not exists attendee_name text,
  add column if not exists attendee_email text;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'meeting_attendees' and column_name = 'entity_id' and is_nullable = 'NO') then
    alter table public.meeting_attendees alter column entity_id drop not null;
  end if;
  if exists (select 1 from information_schema.columns
             where table_name = 'meeting_attendees' and column_name = 'entity_type' and is_nullable = 'NO') then
    alter table public.meeting_attendees alter column entity_type drop not null;
  end if;
end $$;
