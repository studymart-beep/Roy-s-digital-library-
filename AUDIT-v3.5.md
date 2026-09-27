# Roy's Digital Library — v3.5 Hardening Audit Report

## FIXED in this pass

1. **Service worker** — Cache bumped to `roys-v35`; network-first for JS/CSS so users are not stuck on old bundles; shell cache for offline.
2. **Auth session** — Handle `TOKEN_REFRESHED` / `USER_UPDATED`; 5-minute session health check; clear state + toast on expired session.
3. **Sync errors** — Detect JWT/auth failures and show "Session expired… Sign in again" instead of generic sync error.
4. **Image upload** — MIME allow-list (jpeg/png/webp/gif), 5 MB max, sanitize filename.
5. **Item links** — Cleanup relationships when a prompt or library item is soft-deleted.
6. **Storage UPDATE policy** — Re-affirmed in `schema_v35_hardening.sql`.
7. **Share RPC** — Recreated with explicit revoke/grant (anon+authenticated only).
8. **MCP** — Modular scope map (`library:read|write|delete|share`); strip model-supplied `user_id`/tokens; scrub `user_id` from tool outputs; destructive tool annotations + stronger delete wording; content-as-untrusted boundary documented in code.

## Working correctly (verified by inspection)

- Classic `prompts` table separate from `library_items`
- Folder rename/move/delete with cycle prevention in UI
- Soft-delete + LWW (`shouldPreferCloud`)
- Realtime start before fullSync + catch-up pull
- Share snapshot + unguessable token + revoke
- RLS on folders/prompts/images/library_items/item_links/shares (owner policies)
- Local MCP STDIO with user JWT + RLS
- Offline pending queue with entity dedupe

## Partially implemented / intentional limits

- Search is client-side over loaded library (fine for personal use; needs server search at large scale)
- LWW uses device `updatedAt` clocks (acceptable; server revision column deferred)
- Item link ownership enforced by RLS + local-only candidate list (not a DB trigger)
- MCP scopes are flags prepared for OAuth; local STDIO grants all scopes to the token owner

## Security notes

- **No service-role key in frontend** (config only URL + anon)
- Public share never selects from `prompts`; snapshot only via RPC
- Storage paths scoped to `userId/...`
- Cross-user access blocked by RLS if JWT is valid

## Reliability notes

- Startup race mitigated (Realtime → fullSync catchUp)
- Offline queue survives sync failure
- Image binary upload required before metadata in push path

## Production blockers (before paid/public launch)

1. Hosted MCP + OAuth 2.1 not built yet (local STDIO only)
2. No automated test suite in CI (manual checklist only)
3. Email confirmation / password reset UX depends on Supabase dashboard settings
4. Rate limits on MCP are in-process only (not distributed)

## Deferred to next phase (hosted MCP / product)

- HTTPS Streamable HTTP transport
- OAuth 2.1 + PKCE + scopes enforcement from tokens
- Whop entitlement checks at authorization boundary
- Server-side search / pagination for large libraries
- Server-side folder cycle constraint (trigger)
- Health/readiness endpoints for hosted process

## SQL to run (order)

1. schema.sql (if new project)
2. schema_share.sql
3. schema_library.sql
4. **schema_v35_hardening.sql** ← this release

## Files changed

- sw.js
- src/app.js
- src/sync.js
- mcp-server/index.js
- schema_v35_hardening.sql (new)
- AUDIT-v3.5.md (new)
