-- Overlap-ranked candidate search for Ask Joe. The edge function's keyword
-- search used OR across only name/title/company with a 4-word (stopword-polluted)
-- cap, so multi-attribute recruiter queries ("ED at Morgan Stanley in research
-- with a resume") returned nothing even when dozens matched. This ranks every
-- candidate by how many of the query terms appear across their searchable
-- fields (title, company, location, target roles/locations, products,
-- departments), so the people matching the MOST attributes float to the top.
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
      (p.resume_url is not null) as has_resume,
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
      and (not p_want_resume or p.resume_url is not null)
  )
  select s.id, s.overlap, s.has_resume
  from scored s
  where s.overlap > 0
  order by s.overlap desc, s.last_contacted_at desc nulls last
  limit greatest(p_max_rows, 1);
$$;

grant execute on function public.search_people_overlap(text[], boolean, text, int) to service_role, authenticated;
