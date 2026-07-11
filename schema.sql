-- ============================================================================
-- LOGIC ARENA — supabase/schema.sql
-- Run this whole file once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run).
-- ============================================================================

-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists games (
  id text primary key,                    -- short join code, e.g. "KX7F2"
  mode text not null default 'team',       -- 'team' | 'bracket'
  status text not null default 'lobby',
  team_a_name text not null default 'Tim Gold',
  team_b_name text not null default 'Tim Coffee',
  current_question_index int not null default -1,
  question_started_at timestamptz,
  question_duration_seconds int not null default 20,
  questions jsonb not null default '[]'::jsonb,   -- [{question, options[4], correct_index}]
  bracket jsonb,                                   -- {rounds: [[match,...]], currentRound}
  created_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references games(id) on delete cascade,
  name text not null,
  team_group text not null default 'A',    -- 'A' | 'B' — team identity (team mode) or QR intake pool (bracket mode)
  score int not null default 0,
  joined_at timestamptz not null default now()
);

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references games(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  question_index int not null,
  selected_index int not null,
  is_correct boolean not null default false,
  points int not null default 0,
  answered_at timestamptz not null default now(),
  unique (player_id, question_index)       -- one answer per player per question
);

create index if not exists idx_players_game on players(game_id);
create index if not exists idx_answers_game_question on answers(game_id, question_index);

-- ----------------------------------------------------------------------------
-- Atomic score increment (avoids read-then-write race conditions when many
-- players submit answers within the same second)
-- ----------------------------------------------------------------------------

create or replace function increment_player_score(p_player_id uuid, p_amount int)
returns int
language plpgsql
security definer
as $$
declare
  new_score int;
begin
  update players set score = score + p_amount where id = p_player_id
  returning score into new_score;
  return new_score;
end;
$$;

-- IMPORTANT: PostgREST/Supabase exposes every function in `public` to the
-- anon key via RPC by default. Without this revoke, anyone with the public
-- anon key (visible in public/config.js, by design) could call this RPC
-- straight from the browser console and inflate their own score, bypassing
-- submit-answer.js entirely. Only the server (service_role, used solely
-- inside Netlify Functions) is allowed to call it.
revoke execute on function increment_player_score(uuid, int) from public, anon, authenticated;
grant execute on function increment_player_score(uuid, int) to service_role;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- Anyone (anon key, client-side) may READ — that's what powers the Realtime
-- subscriptions on the host screen and every player's phone. Nobody but the
-- server (service_role key, used only inside Netlify Functions, which
-- bypasses RLS entirely) may INSERT/UPDATE/DELETE. This keeps scoring and
-- game-state transitions trustworthy even though the game has no login.
-- ----------------------------------------------------------------------------

alter table games enable row level security;
alter table players enable row level security;
alter table answers enable row level security;

create policy "public read games" on games for select using (true);
create policy "public read players" on players for select using (true);
create policy "public read answers" on answers for select using (true);

-- ----------------------------------------------------------------------------
-- Realtime: add these tables to the publication so Postgres Changes events
-- are emitted for them. (In the Supabase dashboard you can alternatively do
-- this under Database → Replication → supabase_realtime → toggle the 3
-- tables on, instead of running this line.)
-- ----------------------------------------------------------------------------

alter publication supabase_realtime add table games, players, answers;
