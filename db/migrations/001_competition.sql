-- Competition: every day is a contest of total study time between friends.
--
-- The browser talks to Postgres directly through Neon's Data API, so this file
-- IS the backend's security boundary. Two layers decide what a request can do:
--   GRANT  -> which tables/columns/functions the `authenticated` role may touch
--   RLS    -> which rows of those tables it may touch
-- auth.user_id() is the `sub` claim of the caller's verified JWT.
--
-- Anything that must reach across users (adding a friend, reading a friend's
-- totals) goes through a SECURITY DEFINER function instead of a broad policy.
-- Those run as the table owner and bypass RLS, so each one does its own check
-- and pins search_path, so a caller can't shadow the tables it reads.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table public.profiles (
  user_id      text primary key,
  display_name text not null,
  -- 48 random bits: knowing a code is what lets someone become your friend.
  invite_code  text not null unique
    default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  created_at   timestamptz not null default now()
);

-- One row per direction, so "my friends" is a plain lookup on user_id.
create table public.friendships (
  user_id   text not null references public.profiles (user_id) on delete cascade,
  friend_id text not null references public.profiles (user_id) on delete cascade,
  -- UTC so both friends agree on when the head-to-head record began.
  since     date not null default (now() at time zone 'utc')::date,
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create table public.study_sessions (
  -- The id generated in the browser, which makes re-uploading a no-op.
  id         uuid primary key,
  user_id    text not null default auth.user_id(),
  -- The calendar date where the session started, in that person's timezone.
  -- A session crossing midnight counts entirely toward the day it began.
  day        date not null,
  started_at timestamptz not null,
  elapsed_ms bigint not null check (elapsed_ms between 0 and 86400000)
);

create index study_sessions_user_day on public.study_sessions (user_id, day);
create index friendships_friend on public.friendships (friend_id);

-- ── Row-level security ───────────────────────────────────────────────────────

alter table public.profiles       enable row level security;
alter table public.friendships    enable row level security;
alter table public.study_sessions enable row level security;

create policy "see self and friends" on public.profiles
  for select to authenticated
  using (
    user_id = (select auth.user_id())
    or exists (
      select 1 from public.friendships f
      where f.user_id = (select auth.user_id())
        and f.friend_id = profiles.user_id
    )
  );

create policy "see own friendships" on public.friendships
  for select to authenticated
  using (user_id = (select auth.user_id()));

-- Raw sessions stay private, including from friends, who only ever get totals.
create policy "see own sessions" on public.study_sessions
  for select to authenticated
  using (user_id = (select auth.user_id()));

create policy "delete own sessions" on public.study_sessions
  for delete to authenticated
  using (user_id = (select auth.user_id()));

-- Times still come from the browser, so this can't stop deliberate cheating.
-- It rejects sessions that can't have happened: finishing in the future, or
-- labelled with a date that doesn't match when they started. The one-day margin
-- covers timezones; the five minutes covers clock drift.
create policy "add own plausible sessions" on public.study_sessions
  for insert to authenticated
  with check (
    user_id = (select auth.user_id())
    and started_at + elapsed_ms * interval '1 millisecond'
        <= now() + interval '5 minutes'
    and day between (started_at at time zone 'utc')::date - 1
                and (started_at at time zone 'utc')::date + 1
  );

-- ── Table privileges ─────────────────────────────────────────────────────────

grant usage on schema public to authenticated;
-- Every policy above calls auth.user_id() as the requesting role.
grant usage on schema auth to authenticated;
grant execute on function auth.user_id() to authenticated;

-- Column-level: a friend's invite code stays hidden, so they can't pass it on.
grant select (user_id, display_name) on public.profiles to authenticated;
grant select on public.friendships to authenticated;
grant select, insert, delete on public.study_sessions to authenticated;

-- ── Functions ────────────────────────────────────────────────────────────────

-- Creates the caller's profile on first use and returns their own details.
-- The name is read from the auth record rather than taken as an argument, so a
-- client can't choose someone else's name.
create function public.ensure_profile()
returns table (user_id text, display_name text, invite_code text)
language plpgsql security definer set search_path = ''
as $$
declare
  me text := auth.user_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  insert into public.profiles as p (user_id, display_name)
  select me, coalesce(nullif(trim(u.name), ''), 'Anonymous')
  from neon_auth."user" u
  where u.id::text = me
  on conflict on constraint profiles_pkey do update
    set display_name = excluded.display_name;

  return query
    select p.user_id, p.display_name, p.invite_code
    from public.profiles p
    where p.user_id = me;
end;
$$;

-- Connects the caller and the code's owner in both directions.
create function public.add_friend(code text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me text := auth.user_id();
  other public.profiles;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select * into other
  from public.profiles p
  where p.invite_code = upper(trim(code));

  if not found then
    raise exception 'That invite code does not match anyone.' using errcode = 'P0001';
  end if;
  if other.user_id = me then
    raise exception 'That is your own invite code.' using errcode = 'P0001';
  end if;

  insert into public.friendships (user_id, friend_id)
  values (me, other.user_id), (other.user_id, me)
  on conflict do nothing;

  return other.display_name;
end;
$$;

-- Removes both directions, so either person can end the rivalry.
create function public.remove_friend(friend text)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.friendships f
  where auth.user_id() is not null
    and (
      (f.user_id = auth.user_id() and f.friend_id = friend)
      or (f.user_id = friend and f.friend_id = auth.user_id())
    );
$$;

-- Study time per person per day, for the caller and their friends. Friends'
-- days are limited to those since the friendship began, and contain no session
-- start times.
create function public.daily_totals()
returns table (user_id text, day date, total_ms bigint)
language sql stable security definer set search_path = ''
as $$
  select s.user_id, s.day, sum(s.elapsed_ms)::bigint
  from public.study_sessions s
  where s.user_id = auth.user_id()
     or exists (
       select 1 from public.friendships f
       where f.user_id = auth.user_id()
         and f.friend_id = s.user_id
         and s.day >= f.since
     )
  group by s.user_id, s.day
  order by s.day;
$$;

-- Functions are executable by PUBLIC unless revoked.
revoke execute on function public.ensure_profile()    from public;
revoke execute on function public.add_friend(text)    from public;
revoke execute on function public.remove_friend(text) from public;
revoke execute on function public.daily_totals()      from public;

grant execute on function public.ensure_profile()    to authenticated;
grant execute on function public.add_friend(text)    to authenticated;
grant execute on function public.remove_friend(text) to authenticated;
grant execute on function public.daily_totals()      to authenticated;
