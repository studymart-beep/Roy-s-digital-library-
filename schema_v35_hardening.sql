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
