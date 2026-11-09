-- Profile pictures.
--
-- A picture lives in the profile row itself, as a small JPEG data URL. The
-- browser shrinks whatever is chosen to 128x128 first, which comes to roughly
-- 10 KB of text. That avoids running file storage for a thumbnail, at the cost
-- of every read of a profile carrying its picture along.
--
-- Run this before deploying the frontend that goes with it: that frontend
-- selects the new column, and fails where it doesn't exist. The reverse order
-- is safe, since the old frontend ignores the extra column.

begin;

-- The browser's resizing can't be trusted, so the column checks what it's
-- given: a base64 JPEG and nothing else (an SVG could carry a script), no
-- bigger than a real thumbnail would be.
alter table public.profiles
  add column avatar text
  constraint avatar_is_small_jpeg check (
    avatar is null
    or (
      length(avatar) <= 40000
      and avatar ~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$'
    )
  );

-- Visible to whoever can already see the name: yourself and your friends.
grant select (avatar) on public.profiles to authenticated;

-- Setting your own picture only touches your own row, so a plain policy covers
-- it without a SECURITY DEFINER function. The grant is column-level: names and
-- invite codes stay out of reach.
grant update (avatar) on public.profiles to authenticated;

create policy "set own avatar" on public.profiles
  for update to authenticated
  using (user_id = (select auth.user_id()))
  with check (user_id = (select auth.user_id()));

-- ensure_profile also returns the picture. A function's return type can't be
-- changed in place, so it is dropped and recreated; the body is otherwise the
-- one from 002.
drop function public.ensure_profile();

create function public.ensure_profile()
returns table (user_id text, display_name text, invite_code text, avatar text)
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
    select p.user_id, p.display_name, p.invite_code, p.avatar
    from public.profiles p
    where p.user_id = me;
end;
$$;

revoke execute on function public.ensure_profile() from public;
grant execute on function public.ensure_profile() to authenticated;

commit;
