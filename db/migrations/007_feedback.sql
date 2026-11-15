-- Feedback: a signed-in user can send the people building Calenduel an idea or
-- a complaint from the Account page.
--
-- Write-only from the app. Nobody can read feedback through the Data API, not
-- even the person who sent it, so one user can never see another's. Read it in
-- the Neon console (the owner role bypasses RLS):
--   select f.created_at, p.display_name, f.message
--   from public.feedback f join public.profiles p using (user_id)
--   order by f.created_at desc;
--
-- Run this before deploying the frontend that goes with it: that frontend
-- inserts into the new table, and fails where it doesn't exist. The reverse
-- order is safe, since the old frontend never touches it.

begin;

create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  -- Always the caller: the column grant below leaves it out, so a request
  -- can't name somebody else.
  user_id    text not null default auth.user_id()
             references public.profiles (user_id) on delete cascade,
  message    text not null
             constraint message_not_blank check (length(btrim(message)) > 0)
             constraint message_not_huge check (length(message) <= 2000),
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- No select, update or delete policy: with RLS on, those are all refused.
create policy "send own feedback" on public.feedback
  for insert to authenticated
  with check (user_id = (select auth.user_id()));

-- Column-level, so id, user_id and created_at always take their defaults.
grant insert (message) on public.feedback to authenticated;

commit;
