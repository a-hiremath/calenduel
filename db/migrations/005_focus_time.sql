-- Experimental focus time: the part of a session the focus model judged on
-- task. Null until the session is analyzed. It sits beside the totals and
-- never decides who wins a day, which still goes by elapsed time.

alter table public.study_sessions
  add column focus_ms bigint,
  add constraint focus_within_session check (focus_ms between 0 and elapsed_ms);

-- Analysis happens after the session is uploaded, and renaming clears it, so
-- this one column has to be changeable. Like the times, the number comes from
-- the browser: it can't stop deliberate cheating.
grant update (focus_ms) on public.study_sessions to authenticated;

create policy "set own focus" on public.study_sessions
  for update to authenticated
  using (user_id = (select auth.user_id()))
  with check (user_id = (select auth.user_id()));

-- A function's result columns can't be changed in place.
drop function public.daily_totals();

create function public.daily_totals()
returns table (user_id text, day date, total_ms bigint, focus_ms bigint)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return query
    select s.user_id, s.day, sum(s.elapsed_ms)::bigint,
           coalesce(sum(s.focus_ms), 0)::bigint
    from public.study_sessions s
    where s.user_id = me
       or exists (
         select 1 from public.friendships f
         where f.user_id = me
           and f.friend_id = s.user_id
           and s.day >= f.since
       )
    group by s.user_id, s.day
    order by s.day;
end;
$$;

revoke execute on function public.daily_totals() from public;
grant execute on function public.daily_totals() to authenticated;
