-- Expand notes.note_source CHECK constraint to allow send-out values.
--
-- Bug: EditSendOutNotesDialog inserts with note_source='send_out_note',
-- and the stage-move / add-to-job code paths insert with 'stage_move'
-- and 'add_send_out' respectively. The CHECK constraint only allowed
-- the older 5-value set ('call','email','manual_intake','sourcing',
-- 'system'), so every send-out note INSERT failed with 23514
-- check_violation. The UI's error toast flashed too briefly to read,
-- and there are 0 rows with entity_type='send_out' in the notes table
-- despite the dialog being live since PR #218.
--
-- Fix: drop the old constraint and recreate it with the three new
-- values added. No data backfill needed — existing rows already use
-- the original values.
--
-- Audit: same callsites as in PR #218 / #219 / move-stage.ts —
--   src/components/send-outs/EditSendOutNotesDialog.tsx → 'send_out_note'
--   src/lib/mutations/move-stage.ts → 'stage_move'
--   src/pages/JobDetail.tsx → 'stage_move'
--   src/pages/CandidateDetail.tsx → 'add_send_out', 'stage_move'

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_source_check;

ALTER TABLE public.notes
  ADD CONSTRAINT notes_source_check CHECK (
    note_source = ANY (ARRAY[
      'call'::text,
      'email'::text,
      'manual_intake'::text,
      'sourcing'::text,
      'system'::text,
      'send_out_note'::text,
      'stage_move'::text,
      'add_send_out'::text
    ])
  );
