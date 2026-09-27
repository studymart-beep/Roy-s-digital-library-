-- ═══════════════════════════════════════════════════════════════
-- Roy's Digital Library — SHARE SYSTEM (additive, safe)
-- Run AFTER the main schema.sql
-- Does NOT modify folders / prompts / images tables
-- ═══════════════════════════════════════════════════════════════

-- Snapshot share links. Content is copied at share time so:
-- 1) Public never needs SELECT on prompts
-- 2) Revoking disables access without deleting the prompt
create table if not exists public.shares (
  id          text primary key,
  token       text not null unique,
  user_id     uuid not null references auth.users(id) on delete cascade,
  prompt_id   text not null,
  title       text not null,
  content     text not null,
  created_at  bigint not null,
  revoked_at  bigint
);

create index if not exists shares_token_idx on public.shares(token);
create index if not exists shares_user_idx on public.shares(user_id);
create index if not exists shares_prompt_idx on public.shares(prompt_id);

alter table public.shares enable row level security;

-- Owner full access
drop policy if exists "Users can view own shares" on public.shares;
create policy "Users can view own shares"
  on public.shares for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own shares" on public.shares;
create policy "Users can insert own shares"
  on public.shares for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own shares" on public.shares;
create policy "Users can update own shares"
  on public.shares for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own shares" on public.shares;
create policy "Users can delete own shares"
  on public.shares for delete using (auth.uid() = user_id);

-- Public read ONLY via secure RPC (not broad table SELECT for anon)
create or replace function public.get_public_share(p_token text)
returns table (
  title text,
  content text,
  created_at bigint
)
language sql
security definer
set search_path = public
as $$
  select s.title, s.content, s.created_at
  from public.shares s
  where s.token = p_token
    and s.revoked_at is null
  limit 1;
$$;

-- Anyone (including anon) can call the RPC; it only returns matching active share
grant execute on function public.get_public_share(text) to anon, authenticated;

comment on table public.shares is 'Public share snapshots for prompts. Token is unguessable; content is snapshotted.';
