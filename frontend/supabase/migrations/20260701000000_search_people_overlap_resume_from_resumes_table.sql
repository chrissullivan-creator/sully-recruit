-- Ask Joe "candidates with a resume" was gated on people.resume_url IS NOT NULL,
-- but résumés live in the `resumes` table (uploads, email-forward ingestion,
-- Emerald house-formatted PDFs) and `resume_url` is only sporadically set. So a
-- perfectly good candidate with three résumés on file counted as has_resume =
-- false, and "show me interest-rate middle-office candidates WITH resumes"
-- returned nothing. Derive has_resume (and the want_resume filter) from the
-- actual `resumes` rows, falling back to resume_url. Signature unchanged.
create or replace function public.search_people_overlap(
  p_terms       text[],
  p_want_resume boolean default false,
  p_status      text default null,
  p_max_rows    int default 20
) returns table(id uuid, overlap int, has_resume boolean)
language sql stable security definer set search_path = public as $$
  with scored as (
    select
      p.id,
      (
        p.resume_url is not null
        or exists (select 1 from public.resumes rz
                    where rz.candidate_id = p.id and rz.file_path is not null)
      ) as has_resume,
      (
        select count(*) from unnest(p_terms) as t
        where length(trim(t)) > 0
          and position(lower(trim(t)) in lower(
            coalesce(p.full_name,'')       || ' ' || coalesce(p.current_title,'')   || ' ' ||
            coalesce(p.current_company,'') || ' ' || coalesce(p.company_name,'')    || ' ' ||
            coalesce(p.location_text,'')   || ' ' || coalesce(p.target_locations,'')|| ' ' ||
            coalesce(p.target_roles,'')    || ' ' || coalesce(array_to_string(p.products,' '),'') || ' ' ||
            coalesce(array_to_string(p.departments,' '),'')
          )) > 0
      )::int as overlap,
      p.last_contacted_at
    from public.people p
    where p.type = 'candidate' and p.deleted_at is null
      and (p_status is null or p.status = p_status)
      and (
        not p_want_resume
        or p.resume_url is not null
        or exists (select 1 from public.resumes rz
                    where rz.candidate_id = p.id and rz.file_path is not null)
      )
  )
  select s.id, s.overlap, s.has_resume
  from scored s
  where s.overlap > 0
  order by s.overlap desc, s.last_contacted_at desc nulls last
  limit greatest(p_max_rows, 1);
$$;

grant execute on function public.search_people_overlap(text[], boolean, text, int) to service_role, authenticated;
