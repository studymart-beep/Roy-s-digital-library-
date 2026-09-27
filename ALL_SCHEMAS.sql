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
-- ═══════════════════════════════════════════════════════════════
-- Roy's Digital Library — GENERAL LIBRARY ITEMS (Phase 2)
-- Additive only. Does NOT alter folders / prompts / images / shares.
-- Run after schema.sql and schema_share.sql
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.library_items (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  folder_id   text not null,
  item_type   text not null default 'note'
                check (item_type in (
                  'prompt','research','strategy','idea','note',
                  'resource','template','experiment','product_asset'
                )),
  title       text not null,
  content     text not null default '',
  tags        text[] default '{}',
  notes       text default '',
  source_url  text default '',
  metadata    jsonb default '{}'::jsonb,
  is_favorite boolean default false,
  created_at  bigint not null,
  updated_at  bigint not null,
  deleted_at  bigint
);

create index if not exists library_items_user_idx on public.library_items(user_id);
create index if not exists library_items_folder_idx on public.library_items(folder_id);
create index if not exists library_items_type_idx on public.library_items(user_id, item_type);
create index if not exists library_items_updated_idx on public.library_items(user_id, updated_at);
create index if not exists library_items_favorite_idx on public.library_items(user_id, is_favorite)
  where is_favorite = true;

alter table public.library_items enable row level security;

drop policy if exists "Users can view own library_items" on public.library_items;
create policy "Users can view own library_items"
  on public.library_items for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own library_items" on public.library_items;
create policy "Users can insert own library_items"
  on public.library_items for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own library_items" on public.library_items;
create policy "Users can update own library_items"
  on public.library_items for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own library_items" on public.library_items;
create policy "Users can delete own library_items"
  on public.library_items for delete using (auth.uid() = user_id);

-- Optional: relate items without cascading deletes
create table if not exists public.item_links (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  from_id     text not null,
  from_kind   text not null check (from_kind in ('prompt','library_item')),
  to_id       text not null,
  to_kind     text not null check (to_kind in ('prompt','library_item')),
  label       text default '',
  created_at  bigint not null
);

create index if not exists item_links_user_idx on public.item_links(user_id);
create index if not exists item_links_from_idx on public.item_links(from_id);
create index if not exists item_links_to_idx on public.item_links(to_id);

alter table public.item_links enable row level security;

drop policy if exists "Users can view own item_links" on public.item_links;
create policy "Users can view own item_links"
  on public.item_links for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own item_links" on public.item_links;
create policy "Users can insert own item_links"
  on public.item_links for insert with check (auth.uid() = user_id);

-- v3.9: upsert() can take the UPDATE path on retry.
drop policy if exists "Users can update own item_links" on public.item_links;
create policy "Users can update own item_links"
  on public.item_links for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own item_links" on public.item_links;
create policy "Users can delete own item_links"
  on public.item_links for delete using (auth.uid() = user_id);

-- Realtime (run if replication UI is preferred, or keep this)
-- alter publication supabase_realtime add table public.library_items;

comment on table public.library_items is 'General library content: research, strategy, notes, etc. Separate from classic prompts table.';
-- ═══════════════════════════════════════════════════════════════
-- Roy's Digital Library — v3.5 Hardening migration (idempotent)
-- Safe to run after schema.sql + schema_share.sql + schema_library.sql
-- Does NOT drop tables or delete user data
-- ═══════════════════════════════════════════════════════════════

-- Re-affirm Storage UPDATE policy (image replace / upsert)
drop policy if exists "Users can update own images" on storage.objects;
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

-- Ensure shares RPC is locked down (re-create)
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

revoke all on function public.get_public_share(text) from public;
grant execute on function public.get_public_share(text) to anon, authenticated;

-- Realtime for library_items if not already
do $$
begin
  begin
    alter publication supabase_realtime add table public.library_items;
  exception when duplicate_object then null;
  when others then null;
  end;
end $$;

-- Helpful comments for operators
comment on function public.get_public_share(text) is
  'Public share lookup by unguessable token only. Returns title/content snapshot — never user_id.';
-- ═══════════════════════════════════════════════════════════════
-- Roy's Digital Library — v3.6 Production integrity migration
-- Run AFTER: schema.sql, schema_share.sql, schema_library.sql, schema_v35_hardening.sql
-- Additive / idempotent. Does not drop user data.
-- ═══════════════════════════════════════════════════════════════

-- Prevent folder cycles
create or replace function public.prevent_folder_cycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  walk text;
  guard int := 0;
begin
  if NEW.parent_id is null or NEW.parent_id = 'root' then
    return NEW;
  end if;
  if NEW.parent_id = NEW.id then
    raise exception 'FOLDER_CYCLE: folder cannot be its own parent';
  end if;
  walk := NEW.parent_id;
  while walk is not null and walk <> 'root' and guard < 100 loop
    if walk = NEW.id then
      raise exception 'FOLDER_CYCLE: cannot move folder under its own descendant';
    end if;
    select parent_id into walk from public.folders where id = walk and user_id = NEW.user_id;
    guard := guard + 1;
  end loop;
  return NEW;
end;
$$;

drop trigger if exists trg_prevent_folder_cycle on public.folders;
create trigger trg_prevent_folder_cycle
  before insert or update of parent_id on public.folders
  for each row execute function public.prevent_folder_cycle();

-- Cleanup item_links when prompt soft-deleted
create or replace function public.cleanup_links_on_prompt_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.deleted_at is not null and (OLD.deleted_at is null) then
    delete from public.item_links
    where user_id = NEW.user_id
      and (
        (from_id = NEW.id and from_kind = 'prompt')
        or (to_id = NEW.id and to_kind = 'prompt')
      );
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_cleanup_links_prompt on public.prompts;
create trigger trg_cleanup_links_prompt
  after update of deleted_at on public.prompts
  for each row execute function public.cleanup_links_on_prompt_delete();

create or replace function public.cleanup_links_on_library_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.deleted_at is not null and (OLD.deleted_at is null) then
    delete from public.item_links
    where user_id = NEW.user_id
      and (
        (from_id = NEW.id and from_kind = 'library_item')
        or (to_id = NEW.id and to_kind = 'library_item')
      );
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_cleanup_links_library on public.library_items;
create trigger trg_cleanup_links_library
  after update of deleted_at on public.library_items
  for each row execute function public.cleanup_links_on_library_delete();

-- Future entitlement mirror (Whop later). Users can only read own row.
create table if not exists public.entitlements (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  plan        text not null default 'free',
  status      text not null default 'active',
  source      text default 'manual',
  updated_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);

alter table public.entitlements enable row level security;

drop policy if exists "Users can view own entitlement" on public.entitlements;
create policy "Users can view own entitlement"
  on public.entitlements for select using (auth.uid() = user_id);

comment on table public.entitlements is 'Future Whop/subscription mirror. Never trust client for plan.';
-- end of combined schemas
