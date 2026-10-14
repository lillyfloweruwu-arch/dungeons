-- ============================================================
--  Dungeon Legends — Supabase setup
--  Run this ONCE in your Supabase project:
--    Dashboard → SQL Editor → New query → paste all → Run.
-- ============================================================

-- 1. TABLES ---------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  best_floor  int  not null default 0,
  banned      boolean not null default false,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  last_active timestamptz not null default now()
);

create table if not exists public.saves (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,   -- the {s, deck} game blob
  updated_at timestamptz not null default now()
);

-- 2. ROW LEVEL SECURITY --------------------------------------
alter table public.profiles enable row level security;
alter table public.saves    enable row level security;

-- helper: is the current caller an admin?
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Create/fetch the caller's profile, giving a unique username from their first name.
create or replace function public.ensure_profile(p_first_name text)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  base text := nullif(btrim(coalesce(p_first_name, '')), '');
  cand text;
  n    int  := 1;
  prof public.profiles;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into prof from public.profiles where id = uid;
  if found then return prof; end if;

  if base is null then base := 'Player'; end if;
  base := left(base, 20);
  cand := base;
  while exists (select 1 from public.profiles where username = cand) loop
    n := n + 1;
    cand := base || n::text;
  end loop;

  insert into public.profiles (id, username) values (uid, cand) returning * into prof;
  insert into public.saves (user_id, data) values (uid, '{}'::jsonb)
    on conflict (user_id) do nothing;
  return prof;
end; $$;


-- Idempotent hardening for existing installations. Apply before deploying the client.
begin;
alter table public.profiles add column if not exists last_score_at timestamptz;
alter table public.saves add column if not exists save_gen integer not null default 0;

-- Only self/admin can inspect profile metadata; rankings expose two fields via RPC.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (auth.uid() = id or public.is_admin());
drop policy if exists saves_select on public.saves;
create policy saves_select on public.saves for select to authenticated
  using (auth.uid() = user_id or public.is_admin());
revoke select on public.profiles, public.saves from public, anon;
grant select on public.profiles, public.saves to authenticated;

create or replace function public.get_leaderboard(p_limit int)
returns table(username text, best_floor int)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.username, p.best_floor from public.profiles p
  where not p.banned order by p.best_floor desc, p.username
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

-- Lock the profile first, then the save (also serializes insertion of absent saves).
-- Throttle errors are explicit so clients retry instead of claiming a lost write saved.
create or replace function public.save_game(p_data jsonb, p_save_gen int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  saved public.saves;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if jsonb_typeof(p_data) is distinct from 'object'
     or jsonb_typeof(p_data->'s') is distinct from 'object' then
    raise exception 'invalid save object';
  end if;
  if octet_length(p_data::text) > 204800 then raise exception 'save too large'; end if;
  select * into prof from public.profiles where id = uid for update;
  if not found then raise exception 'profile missing'; end if;
  select * into saved from public.saves where user_id = uid for update;
  if p_save_gen is distinct from coalesce(saved.save_gen, 0) then raise exception 'stale save generation'; end if;
  if prof.banned then raise exception 'account banned'; end if;
  if saved.user_id is not null and clock_timestamp() - saved.updated_at < interval '3 seconds' then
    raise exception 'save cooldown';
  end if;
  insert into public.saves(user_id, data, updated_at) values(uid, p_data, clock_timestamp())
    on conflict(user_id) do update set data = excluded.data, updated_at = excluded.updated_at;
  update public.profiles set last_active = clock_timestamp() where id = uid;
end; $$;

-- No bootstrap bypass: even a player with no server best advances one step at a time.
-- The client queues a local/cloud best ahead of the server and catches up every 5s.
-- Existing scores are preserved. The game records the next unlocked floor, starting at 1.
-- This limits submissions; it cannot prove gameplay in a fully client-side offline game.
create or replace function public.submit_score(p_floor int, p_save_gen int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  prof public.profiles;
  current_gen int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_floor is null or p_floor < 1 or p_floor > 500 then raise exception 'invalid floor'; end if;
  select * into prof from public.profiles where id = uid for update;
  if not found then raise exception 'profile missing'; end if;
  select save_gen into current_gen from public.saves where user_id = uid for update;
  if p_save_gen is distinct from coalesce(current_gen, 0) then raise exception 'stale save generation'; end if;
  if prof.banned then raise exception 'account banned'; end if;
  if p_floor <= prof.best_floor then return; end if; -- idempotent retry after a lost response
  if p_floor > prof.best_floor + 1 then raise exception 'score progression limit'; end if;
  if clock_timestamp() - prof.last_score_at < interval '5 seconds' then raise exception 'score cooldown'; end if;
  update public.profiles set best_floor = p_floor, last_score_at = clock_timestamp(),
    last_active = clock_timestamp() where id = uid;
end; $$;

-- Old tabs must not bypass generation checks through the old overloads.
create or replace function public.save_game(p_data jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin raise exception 'client update required'; end; $$;
create or replace function public.submit_score(p_floor int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin raise exception 'client update required'; end; $$;
revoke execute on function public.save_game(jsonb) from public, anon, authenticated;
revoke execute on function public.submit_score(int) from public, anon, authenticated;

-- All moderation and ordinary writes lock profile then save, in that order.
-- Keep a tombstone save after resets so old tabs cannot recreate a deleted row.
create or replace function public.admin_reset_player(uid uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  perform 1 from public.profiles where id = uid for update;
  if not found then raise exception 'player missing'; end if;
  update public.profiles set best_floor = 0, last_score_at = null where id = uid;
  insert into public.saves(user_id, data, save_gen, updated_at)
    values(uid, '{"s":{}}'::jsonb, 1, '-infinity')
    on conflict(user_id) do update set data = excluded.data,
      save_gen = public.saves.save_gen + 1, updated_at = excluded.updated_at;
end; $$;

create or replace function public.admin_wipe_items(uid uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  perform 1 from public.profiles where id = uid for update;
  if not found then raise exception 'player missing'; end if;
  insert into public.saves(user_id, data) values(uid, '{"s":{}}'::jsonb)
    on conflict(user_id) do nothing;
  update public.saves set data = jsonb_set(
      case when jsonb_typeof(data) = 'object' then data else '{}'::jsonb end,
      '{s}', (case when jsonb_typeof(data->'s') = 'object' then data->'s' else '{}'::jsonb end)
        || '{"inventory":[],"equipped":{"weapon":null,"armor":null,"helmet":null,"boots":null,"accessory":null,"trinket":null}}'::jsonb),
    save_gen = save_gen + 1, updated_at = '-infinity'
    where user_id = uid;
end; $$;

create or replace function public.admin_ban_player(uid uuid, p_banned boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_banned is null then raise exception 'ban value missing'; end if;
  perform 1 from public.profiles where id = uid for update;
  if not found then raise exception 'player missing'; end if;
  update public.profiles set banned = p_banned where id = uid;
  insert into public.saves(user_id, data, save_gen, updated_at)
    values(uid, '{"s":{}}'::jsonb, 1, '-infinity')
    on conflict(user_id) do update set save_gen = public.saves.save_gen + 1,
      updated_at = excluded.updated_at;
end; $$;

-- No direct table mutations, including from admin clients: use the atomic RPCs.
drop policy if exists profiles_admin_update on public.profiles;
drop policy if exists profiles_admin_delete on public.profiles;
drop policy if exists saves_admin_update on public.saves;
drop policy if exists saves_admin_delete on public.saves;
revoke insert, update, delete, truncate, references, trigger on public.profiles, public.saves from public, anon, authenticated;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.ensure_profile(text) from public, anon;
revoke execute on function public.save_game(jsonb,int) from public, anon;
revoke execute on function public.submit_score(int,int) from public, anon;
revoke execute on function public.get_leaderboard(int) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.ensure_profile(text) to authenticated;
grant execute on function public.save_game(jsonb,int) to authenticated;
grant execute on function public.submit_score(int,int) to authenticated;
grant execute on function public.get_leaderboard(int) to authenticated;
revoke execute on function public.admin_reset_player(uuid) from public, anon;
revoke execute on function public.admin_wipe_items(uuid) from public, anon;
revoke execute on function public.admin_ban_player(uuid,boolean) from public, anon;
grant execute on function public.admin_reset_player(uuid) to authenticated;
grant execute on function public.admin_wipe_items(uuid) to authenticated;
grant execute on function public.admin_ban_player(uuid,boolean) to authenticated;
commit;
