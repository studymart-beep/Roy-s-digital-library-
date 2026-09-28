-- ═══════════════════════════════════════════════════════════════
-- Roy's Digital Library — EVERYTHING AFTER THE SHARE SYSTEM
-- Run this ONCE in Supabase → SQL Editor → New query → Run
-- Safe to re-run (idempotent). Does not delete your data.
--
-- You said you already have: base schema + share links.
-- This adds: library_items, item_links, spreadsheet/document/
-- presentation types, and item_links UPDATE policy.
-- ═══════════════════════════════════════════════════════════════

-- ── 1) General library items (research, notes, strategies, sheets…) ──
create table if not exists public.library_items (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  folder_id   text not null,
  item_type   text not null default 'note',
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

-- ── 2) Allow spreadsheet / document / presentation types ──
-- (Also keeps research, note, strategy, etc.)
alter table public.library_items drop constraint if exists library_items_item_type_check;

alter table public.library_items
  add constraint library_items_item_type_check
  check (item_type in (
    'prompt','research','strategy','idea','note',
    'resource','template','experiment','product_asset',
    'spreadsheet','document','presentation'
  ));

-- ── 3) Related-items links ──
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

drop policy if exists "Users can update own item_links" on public.item_links;
create policy "Users can update own item_links"
  on public.item_links for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own item_links" on public.item_links;
create policy "Users can delete own item_links"
  on public.item_links for delete using (auth.uid() = user_id);

-- ── 4) Realtime (optional but recommended) ──
-- If this errors with "already member of publication", ignore it.
do $$
begin
  begin
    alter publication supabase_realtime add table public.library_items;
  exception when duplicate_object then null;
  when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.item_links;
  exception when duplicate_object then null;
  when others then null;
  end;
end $$;

comment on table public.library_items is
  'Research, strategy, notes, spreadsheets, documents, presentations, etc.';
comment on table public.item_links is
  'Related-item links between prompts and library items.';
