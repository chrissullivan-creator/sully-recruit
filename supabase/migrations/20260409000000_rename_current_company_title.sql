-- Rename current_company → company and current_title → title on candidates
-- to unify naming with contacts table (which already uses company/title)

ALTER TABLE public.candidates RENAME COLUMN current_company TO company;
ALTER TABLE public.candidates RENAME COLUMN current_title TO title;
