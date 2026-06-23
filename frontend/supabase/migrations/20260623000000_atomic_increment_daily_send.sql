-- Atomic daily-send counter for the sequence engine.
--
-- send-time-calculator.ts:incrementDailySend used to do a non-atomic
-- read-then-write (select count → branch update/insert). Under concurrent or
-- batch sends (a BD sequence enrolls 20+ contacts that fire together) two
-- writers read the same count and one increment was lost, or both inserted and
-- the UNIQUE(account_id, channel, send_date) violation was silently swallowed.
-- Net effect: the daily cap under-counted and outreach could exceed the
-- per-channel limit → LinkedIn / email rate-limit strikes and account bans.
--
-- This collapses the whole thing into one atomic statement and returns the new
-- count so the caller can gate on it. The table already has the matching
-- unique constraint (20260414000000_add_v2_sequence_tables.sql).

create or replace function public.increment_daily_send(
  p_account_id text,
  p_channel    text,
  p_send_date  date
) returns integer
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.daily_send_log (account_id, channel, send_date, count)
  values (p_account_id, p_channel, p_send_date, 1)
  on conflict (account_id, channel, send_date)
  do update set count = public.daily_send_log.count + 1
  returning count;
$$;

revoke all on function public.increment_daily_send(text, text, date) from public;
revoke all on function public.increment_daily_send(text, text, date) from anon, authenticated;
grant execute on function public.increment_daily_send(text, text, date) to service_role;
