-- Inside a SECURITY DEFINER function, auth.user_id() intermittently returns NULL
-- under concurrent requests (35-55% of calls in a burst test), even with a valid
-- token. Nothing fails loudly: daily_totals just returned no rows, so a scoreboard
-- could show 0m for everyone. Why it happens wasn't determined. In the same test,
-- RLS policies, which run as the caller, were unaffected, so they keep using
-- auth.user_id().
--
-- The fix reads the JWT claims the Data API sets for the request, which were
-- correct on every call. The API only sets them after verifying the token's
-- signature, and they can't be set through a request: forged tokens are rejected
-- before any SQL runs (tested).

-- Not an exposed schema, so this can't be called directly through the Data API.
create schema if not exists app_private;

create function app_private.caller_id()
returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
$$;

revoke execute on function app_private.caller_id() from public;

create or replace function public.ensure_profile()
returns table (user_id text, display_name text, invite_code text)
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
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

create or replace function public.add_friend(code text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
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

-- Fails loudly on a missing identity: silently doing nothing would tell the
-- person they had removed a friend who could still see their totals.
create or replace function public.remove_friend(friend text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  delete from public.friendships f
  where (f.user_id = me and f.friend_id = friend)
     or (f.user_id = friend and f.friend_id = me);
end;
$$;

-- Likewise: an error here is retried, but an empty result looks like zero study.
create or replace function public.daily_totals()
returns table (user_id text, day date, total_ms bigint)
language plpgsql stable security definer set search_path = ''
as $$
declare
  me text := app_private.caller_id();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  return query
    select s.user_id, s.day, sum(s.elapsed_ms)::bigint
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
