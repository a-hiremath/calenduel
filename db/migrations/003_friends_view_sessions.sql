-- Friends can now see each other's individual sessions: when and for how long.
-- Clips and task names still never leave the device.
--
-- The table's RLS stays owner-only. A "friends can select" policy would also
-- widen every other query on the table, including the one that decides what
-- still needs uploading. One function that does its own friendship check keeps
-- the exposure in a single place, and limits it to these columns.

-- A friend's latest sessions since the friendship began, the same boundary the
-- head-to-head record uses. Anyone who isn't a friend gets no rows, so this
-- doesn't reveal whether an account exists. Removing a friend ends access at once.
create function public.friend_sessions(friend text)
returns table (id uuid, started_at timestamptz, elapsed_ms bigint)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  return query
    select s.id, s.started_at, s.elapsed_ms
    from public.study_sessions s
    join public.friendships f
      on f.user_id = me and f.friend_id = s.user_id
    where s.user_id = friend
      and s.day >= f.since
    order by s.started_at desc
    limit 50;
end;
$$;

revoke execute on function public.friend_sessions(text) from public;
grant execute on function public.friend_sessions(text) to authenticated;
