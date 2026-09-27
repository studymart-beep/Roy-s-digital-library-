-- ═══════════════════════════════════════════════════════════════
-- Roy's Digital Library — Supabase Schema
-- Run this in your Supabase project: SQL Editor → New query → Run
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ── Folders ───────────────────────────────────────────────────
create table if not exists public.folders (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  parent_id   text,                          -- null = root level
  created_at  bigint not null,
  updated_at  bigint not null,
  deleted_at  bigint                         -- soft delete
);

create index if not exists folders_user_idx on public.folders(user_id);
create index if not exists folders_parent_idx on public.folders(parent_id);
create index if not exists folders_updated_idx on public.folders(user_id, updated_at);

-- ── Prompts ───────────────────────────────────────────────────
create table if not exists public.prompts (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  folder_id   text not null,
  title       text not null,
  content     text not null,
  tags        text[] default '{}',
  notes       text default '',
  is_favorite boolean default false,
  created_at  bigint not null,
  updated_at  bigint not null,
  deleted_at  bigint                         -- soft delete
);

create index if not exists prompts_user_idx on public.prompts(user_id);
create index if not exists prompts_folder_idx on public.prompts(folder_id);
create index if not exists prompts_updated_idx on public.prompts(user_id, updated_at);
create index if not exists prompts_favorite_idx on public.prompts(user_id, is_favorite) where is_favorite = true;

-- ── Images (metadata only — files live in Storage) ────────────
create table if not exists public.images (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  parent_id   text not null,                 -- folder or prompt id
  name        text not null,
  storage_path text not null,                -- path in Supabase Storage
  created_at  bigint not null,
  updated_at  bigint not null,
  deleted_at  bigint
);

create index if not exists images_user_idx on public.images(user_id);
create index if not exists images_parent_idx on public.images(parent_id);

-- ── Sync metadata (optional, for advanced conflict tracking) ──
create table if not exists public.sync_log (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id   text not null,
  action      text not null,                 -- insert | update | delete
  payload     jsonb,
  created_at  timestamptz default now()
);

-- ── Row Level Security ────────────────────────────────────────
alter table public.folders enable row level security;
alter table public.prompts enable row level security;
alter table public.images enable row level security;
alter table public.sync_log enable row level security;

-- Folders policies
create policy "Users can view own folders"
  on public.folders for select using (auth.uid() = user_id);
create policy "Users can insert own folders"
  on public.folders for insert with check (auth.uid() = user_id);
create policy "Users can update own folders"
  on public.folders for update using (auth.uid() = user_id);
create policy "Users can delete own folders"
  on public.folders for delete using (auth.uid() = user_id);

-- Prompts policies
create policy "Users can view own prompts"
  on public.prompts for select using (auth.uid() = user_id);
create policy "Users can insert own prompts"
  on public.prompts for insert with check (auth.uid() = user_id);
create policy "Users can update own prompts"
  on public.prompts for update using (auth.uid() = user_id);
create policy "Users can delete own prompts"
  on public.prompts for delete using (auth.uid() = user_id);

-- Images policies
create policy "Users can view own images"
  on public.images for select using (auth.uid() = user_id);
create policy "Users can insert own images"
  on public.images for insert with check (auth.uid() = user_id);
create policy "Users can update own images"
  on public.images for update using (auth.uid() = user_id);
create policy "Users can delete own images"
  on public.images for delete using (auth.uid() = user_id);

-- Sync log
create policy "Users can view own sync log"
  on public.sync_log for select using (auth.uid() = user_id);
create policy "Users can insert own sync log"
  on public.sync_log for insert with check (auth.uid() = user_id);

-- ── Storage bucket for images ─────────────────────────────────
-- Run in Supabase Dashboard → Storage → New bucket
-- Bucket name: prompt-images
-- Public: false (private)
-- Then add policy:

-- Storage policies (run after creating the bucket)
-- Allow authenticated users to upload to their own folder
insert into storage.buckets (id, name, public)
values ('prompt-images', 'prompt-images', false)
on conflict (id) do nothing;

create policy "Users can upload own images"
  on storage.objects for insert
  with check (
    bucket_id = 'prompt-images'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can view own images"
  on storage.objects for select
  using (
    bucket_id = 'prompt-images'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete own images"
  on storage.objects for delete
  using (
    bucket_id = 'prompt-images'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Required for upsert:true (replace existing object at same path).
-- Without UPDATE, retries / image replacements fail with a permission error.
create policy "Users can update own images"
  on storage.objects for update
  using (
    bucket_id = 'prompt-images'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'prompt-images'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Realtime ──────────────────────────────────────────────────
-- Enable realtime for the tables (Dashboard → Database → Replication)
-- Or run:
alter publication supabase_realtime add table public.folders;
alter publication supabase_realtime add table public.prompts;
alter publication supabase_realtime add table public.images;

-- ═══════════════════════════════════════════════════════════════
-- v2.3 patch (for projects that already ran the original schema)
-- Run this once if the Storage UPDATE policy is missing:
-- ═══════════════════════════════════════════════════════════════
-- create policy "Users can update own images"
--   on storage.objects for update
--   using (
--     bucket_id = 'prompt-images'
--     and auth.role() = 'authenticated'
--     and (storage.foldername(name))[1] = auth.uid()::text
--   )
--   with check (
--     bucket_id = 'prompt-images'
--     and auth.role() = 'authenticated'
--     and (storage.foldername(name))[1] = auth.uid()::text
--   );
