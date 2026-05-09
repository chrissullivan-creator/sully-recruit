-- Routes a sequence's enrollments to either the Trigger.dev or the
-- Inngest engine.
--
-- During the migration window both engines run side-by-side. The
-- /api/trigger-sequence-enroll route reads `sequences.engine` and
-- dispatches to whichever owns that sequence's runs. Existing rows
-- default to 'trigger' so nothing changes on deploy; flipping a row
-- to 'inngest' is the cutover decision per-sequence.

alter table public.sequences
  add column if not exists engine text not null default 'trigger';

alter table public.sequences
  drop constraint if exists sequences_engine_check;

alter table public.sequences
  add constraint sequences_engine_check
    check (engine in ('trigger', 'inngest'));

comment on column public.sequences.engine is
  'Which workflow engine handles this sequence''s enrollments. ''trigger'' = Trigger.dev (legacy); ''inngest'' = Inngest durable function. Migration default is ''trigger''. Phase 2 of INNGEST_MIGRATION.md.';
