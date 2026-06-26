-- AI Command Center dashboard summary: one round-trip powering the morning
-- intelligence view. SECURITY DEFINER (org-wide aggregate, mirrors the existing
-- dashboard's org-wide scope); read-only/STABLE. Returns a single jsonb blob of
-- KPI counts + small preview lists. Heuristics tie out with the rest of the app
-- (pipeline stages, send_outs, joe_briefings).
create or replace function public.command_center_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
cal as (select count(*) c from call_logs where started_at >= current_date),
iv as (select count(*) c from interviews where scheduled_at >= now() and scheduled_at < now()+interval '7 days' and cancelled_at is null),
off as (select count(*) c from send_outs where stage='offer' and deleted_at is null),
plc as (select count(*) c, coalesce(sum(coalesce(fee_amount, salary*fee_pct/100)),0) rev from placements where placed_at >= date_trunc('month',current_date)),
os as (select count(*) c from jobs where status in ('hot','offer_made') and deleted_at is null),
atf as (select round(avg(extract(day from p.placed_at - j.created_at))) d from placements p join jobs j on j.id=p.job_id where p.placed_at >= current_date - interval '365 days'),
fu as (select count(*) c from tasks where due_date <= current_date and status<>'completed' and completed_at is null),
rtm as (select count(*) c from people where type='candidate' and deleted_at is null and (next_action is not null or last_sequence_sentiment in ('interested','booked_meeting') or last_responded_at > now()-interval '7 days')),
bm as (select count(*) c from people where type='candidate' and deleted_at is null and current_total_comp is not null and target_total_comp is not null and target_total_comp > current_total_comp*1.1),
risk as (select count(*) c from jobs j where j.status in ('hot','offer_made') and j.deleted_at is null
   and not exists (select 1 from candidate_jobs cj where cj.job_id=j.id and cj.deleted_at is null and cj.stage_updated_at>now()-interval '14 days')
   and not exists (select 1 from send_outs so where so.job_id=j.id and so.deleted_at is null and so.updated_at>now()-interval '14 days')
   and (j.last_sourced_at is null or j.last_sourced_at < now()-interval '14 days')),
jb as (select count(*) c from joe_briefings where status in ('open','snoozed') and brief_date >= current_date-2),
fc as (select coalesce(sum(coalesce(so.base_comp_max, so.base_comp_min,0)*0.25),0) pipe from send_outs so where so.stage='offer' and so.deleted_at is null),
rtm_list as (select coalesce(jsonb_agg(x),'[]'::jsonb) j from (
    select p.id, p.full_name name, p.current_title title, p.current_company company, p.last_sequence_sentiment sentiment
    from people p where p.type='candidate' and p.deleted_at is null
      and (p.next_action is not null or p.last_sequence_sentiment in ('interested','booked_meeting') or p.last_responded_at > now()-interval '7 days')
    order by p.last_responded_at desc nulls last limit 6) x),
bm_list as (select coalesce(jsonb_agg(x),'[]'::jsonb) j from (
    select p.id, p.full_name name, p.current_title title, p.current_company company, p.current_total_comp cur, p.target_total_comp tgt
    from people p where p.type='candidate' and p.deleted_at is null and p.current_total_comp is not null and p.target_total_comp is not null and p.target_total_comp > p.current_total_comp*1.1
    order by (p.target_total_comp - p.current_total_comp) desc limit 6) x),
risk_list as (select coalesce(jsonb_agg(x),'[]'::jsonb) j from (
    select j.id, j.title, j.company_name company, j.last_sourced_at
    from jobs j where j.status in ('hot','offer_made') and j.deleted_at is null
      and not exists (select 1 from candidate_jobs cj where cj.job_id=j.id and cj.deleted_at is null and cj.stage_updated_at>now()-interval '14 days')
      and not exists (select 1 from send_outs so where so.job_id=j.id and so.deleted_at is null and so.updated_at>now()-interval '14 days')
      and (j.last_sourced_at is null or j.last_sourced_at < now()-interval '14 days')
    order by j.last_sourced_at asc nulls first limit 6) x),
joe_list as (select coalesce(jsonb_agg(x),'[]'::jsonb) j from (
    select b.id, b.entity_type, b.entity_id, b.category, b.headline, b.rationale, b.score
    from joe_briefings b where b.status in ('open','snoozed') and b.brief_date >= current_date-2
    order by b.score desc nulls last, b.brief_date desc limit 6) x)
select jsonb_build_object(
  'calls_today',(select c from cal),'interviews_next7',(select c from iv),'offers_out',(select c from off),
  'placements_mtd',(select c from plc),'revenue_mtd',(select rev from plc),'open_searches',(select c from os),
  'avg_days_to_fill',(select d from atf),'followups_due',(select c from fu),
  'ready_to_move_count',(select c from rtm),'below_market_count',(select c from bm),
  'searches_at_risk_count',(select c from risk),'joe_briefings_count',(select c from jb),'forecast_pipeline',(select pipe from fc),
  'ready_to_move',(select j from rtm_list),'below_market',(select j from bm_list),
  'at_risk',(select j from risk_list),'joe_recs',(select j from joe_list)
);
$$;

grant execute on function public.command_center_summary() to authenticated, service_role;
