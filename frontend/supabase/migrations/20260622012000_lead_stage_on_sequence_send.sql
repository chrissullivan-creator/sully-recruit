-- Advance a lead to 'reached_out' when a SEQUENCE sends to one of the job's
-- contacts. Sequence sends are logged in sequence_step_logs (NOT the messages
-- table), so the messages-based reached_out trigger never fired for BD
-- sequences tied to a job. This adds the missing path. BD = contact-audience
-- only (candidate sourcing sequences don't count). Forward-only via
-- advance_job_lead_stage; never downgrades; only while status='lead'.

create or replace function public.trg_lead_stage_on_step_sent()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_contact uuid;
  v_seq uuid;
  v_job uuid;
  v_jobs uuid[];
begin
  begin
    if coalesce(new.channel,'') = 'call' then return new; end if;

    select e.contact_id, e.sequence_id into v_contact, v_seq
      from public.sequence_enrollments e where e.id = new.enrollment_id;
    if v_contact is null then return new; end if;  -- only contact (BD) sends

    select s.job_id, s.job_ids into v_job, v_jobs
      from public.sequences s where s.id = v_seq;

    -- The job(s) the sequence is tied to.
    if v_job is not null then
      perform public.advance_job_lead_stage(v_job, 'reached_out');
    end if;
    if v_jobs is not null and array_length(v_jobs, 1) is not null then
      perform public.advance_job_lead_stage(jid, 'reached_out') from unnest(v_jobs) as jid;
    end if;
    -- Fallback for sequences not tied to a job: the contact's job links.
    if v_job is null and (v_jobs is null or array_length(v_jobs, 1) is null) then
      perform public.advance_job_lead_stage(jc.job_id, 'reached_out')
        from public.job_contacts jc where jc.contact_id = v_contact;
    end if;
  exception when others then null;  -- never block a send's status update
  end;
  return new;
end; $$;

drop trigger if exists lead_stage_on_step_sent on public.sequence_step_logs;
create trigger lead_stage_on_step_sent
  after insert or update of status on public.sequence_step_logs
  for each row
  when (new.status = 'sent')
  execute function public.trg_lead_stage_on_step_sent();

-- Backfill: leads whose tied/linked BD sequence has already sent to a contact.
update public.jobs j
set lead_stage = 'reached_out', updated_at = now()
where j.status = 'lead'
  and coalesce(j.lead_stage, 'new') in ('new','contacts_added')
  and exists (
    select 1
    from public.sequence_step_logs sl
    join public.sequence_enrollments e on e.id = sl.enrollment_id
    join public.sequences s on s.id = e.sequence_id
    where sl.status = 'sent'
      and e.contact_id is not null
      and coalesce(sl.channel,'') <> 'call'
      and (
        s.job_id = j.id
        or j.id = any(coalesce(s.job_ids, '{}'::uuid[]))
        or exists (select 1 from public.job_contacts jc
                    where jc.contact_id = e.contact_id and jc.job_id = j.id)
      )
  );
