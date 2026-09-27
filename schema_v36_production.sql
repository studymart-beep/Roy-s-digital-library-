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
