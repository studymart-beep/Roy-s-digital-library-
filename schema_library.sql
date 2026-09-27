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

-- v3.9: item_links was missing an UPDATE policy. sync.js writes item_links
-- with upsert() (INSERT ... ON CONFLICT DO UPDATE), so a retry after a
-- partially-successful push hits the UPDATE path and was failing with a
-- Postgres permission error since only INSERT/SELECT/DELETE existed. Scoped
-- the same way as every other own-row policy here: a user may only update a
-- link row they already own, and the check clause blocks re-pointing a row
-- at a different user_id via the update.
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
