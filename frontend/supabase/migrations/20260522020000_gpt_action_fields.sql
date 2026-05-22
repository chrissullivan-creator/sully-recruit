-- Columns used by the Ask Joe Send-Out custom GPT action.
--
-- The GPT produces the final branded resume + intro blurb inside ChatGPT,
-- then writes the text back here via /api/gpt/save-formatted-sendout so
-- Sully Recruit has a queryable record of what was submitted (even when
-- the PDF itself was downloaded straight from ChatGPT to the user's
-- inbox and never travelled through our storage bucket).

ALTER TABLE public.formatted_resumes
  ADD COLUMN IF NOT EXISTS content_text TEXT;

COMMENT ON COLUMN public.formatted_resumes.content_text IS
  'Plain-text / markdown body of the formatted resume, populated when the source is a GPT action rather than an uploaded file. Null when file_path is set instead.';

ALTER TABLE public.send_outs
  ADD COLUMN IF NOT EXISTS submission_blurb TEXT;

COMMENT ON COLUMN public.send_outs.submission_blurb IS
  'Short candidate-intro paragraph written for this submission. Populated by the GPT send-out action or by the in-app generator.';
