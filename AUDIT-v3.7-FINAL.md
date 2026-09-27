# AUDIT-v3.7-FINAL

## Architecture
PWA → IndexedDB/offline → Supabase (Auth, DB, Storage, Realtime, RLS)
Local MCP STDIO → Bearer-equivalent ROYS_ACCESS_TOKEN → RLS
Hosted MCP HTTP → Authorization: Bearer <Supabase user JWT> → tool layer → RLS

## Hosted MCP
- Transport: HTTP JSON (`POST /mcp/tools/:name`, `POST /mcp/rpc`)
- Auth: validated Supabase access token via `auth.getUser` (not client user_id)
- OAuth 2.1 Authorization Server: **not implemented** (blocker for pure OAuth MCP clients)
- Scopes: library:read|write|delete|share enforced in tool layer
- Rate limit: per user + per IP in-process
- Idempotency: optional `idempotency_key` on create item/folder

## Whop
- Status: scaffold (`getUserEntitlement`, `entitlements` table)
- Webhooks: not live

## Tests executed in this environment
- Unit: 24 passed
- Security: executed with tools module
- Integration: skipped without live credentials
- E2E browser: not run (no Playwright project credentials)
