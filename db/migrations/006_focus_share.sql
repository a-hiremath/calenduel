-- Focus as a share of time: totals also report how much time has been
-- analyzed, so focus time can be divided by the time it was measured over.
-- Dividing by total time instead would score every unanalyzed session as 0%.

-- A function's result columns can't be changed in place.
drop function public.daily_totals();

create function public.daily_totals()
returns table (user_id text, day date, total_ms bigint, focus_ms bigint, analyzed_ms bigint)
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
           coalesce(sum(s.focus_ms), 0)::bigint,
           coalesce(sum(s.elapsed_ms) filter (where s.focus_ms is not null), 0)::bigint
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
