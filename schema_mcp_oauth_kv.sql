-- Persist MCP OAuth sessions without a Render disk (free tier).
-- Run in Supabase SQL Editor. Then set SUPABASE_SERVICE_ROLE_KEY on Render
-- (Settings → API → service_role — NEVER put this in the frontend).

create table if not exists public.mcp_oauth_kv (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Only service_role should access this (no anon/authenticated policies).
alter table public.mcp_oauth_kv enable row level security;

comment on table public.mcp_oauth_kv is
  'Encrypted OAuth token store for hosted MCP. Written only with service_role.';
