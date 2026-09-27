-- Roy's Digital Library — v3.9 security/data-integrity migration
-- Idempotent; safe to run after the v3.8 schema.

alter table public.item_links enable row level security;
drop policy if exists "Users can update own item_links" on public.item_links;
create policy "Users can update own item_links"
  on public.item_links for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
