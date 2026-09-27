# Royce Prompt Library — Production Handoff Checklist

## Code-side work completed in v3.9.1
- [x] `app.js` parses successfully; original `Unexpected identifier 's'` crash fixed.
- [x] Desktop bottom navigation remains visible at desktop widths.
- [x] App JS/CSS cache-busting and service-worker cache version updated.
- [x] Hosted MCP rejects raw Supabase JWTs; OAuth-issued tokens are required.
- [x] OAuth scopes are enforced for hosted MCP tools.
- [x] OAuth store uses AES-256-GCM when `MCP_OAUTH_STORE_KEY` is configured and never falls back to plaintext.
- [x] Legacy plaintext OAuth store migration is supported.
- [x] Folder deletion cascades to `library_items`.
- [x] `item_links` UPDATE RLS policy added to source schema, all-schemas bootstrap, and v3.9 migration.
- [x] `item_links` pull/pending-queue race fixed.
- [x] `sourceUrl` accepts only HTTP/HTTPS for clickable links.
- [x] Hosted MCP Protected Resource Metadata and OAuth discovery endpoints are present.
- [x] Hosted MCP returns a 401 OAuth challenge for unauthenticated MCP requests.
- [x] Production smoke-test script included.

## Your deployment actions — these cannot be completed from the ZIP

### 1. Supabase
- [ ] Apply `ALL_SCHEMAS.sql` to the production Supabase project, OR apply the migrations in the documented order.
- [ ] Confirm Auth Site URL and redirect URLs.
- [ ] Confirm `prompt-images` storage bucket and policies.
- [ ] Confirm Realtime is enabled for required tables.
- [ ] Enable backups.

### 2. PWA hosting
- [ ] Deploy the root PWA files on an HTTPS domain.
- [ ] Open the live site in a fresh/private browser window.
- [ ] Sign in.
- [ ] Create/edit/delete a test item.
- [ ] Test sync, favorites, search, folders and bottom navigation.
- [ ] Install the PWA and verify the service-worker update.

### 3. Hosted MCP
Deploy `mcp-server/` to a Node 18+ host/container with persistent storage.

Required environment variables:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PUBLIC_URL=https://YOUR-MCP-DOMAIN`
- `MCP_OAUTH_STORE_KEY` — generate with `openssl rand -base64 32`
- `MCP_OAUTH_STORE_PATH` — persistent path surviving restarts
- `OAUTH_REDIRECT_ALLOWLIST` — exact OAuth callback origins required by your cloud client

Do not put `service_role` in the frontend or use it for MCP user operations.

### 4. Verify the public MCP endpoint
After deployment, run:

```bash
node scripts/production-smoke.mjs https://YOUR-MCP-DOMAIN
```

It must pass:
- `/health`
- `/ready`
- Protected Resource Metadata
- OAuth Authorization Server Metadata
- PKCE S256 advertisement
- unauthenticated `/mcp` returns 401

### 5. Connect Claude/cloud MCP
Use the exact public URL:

```text
https://YOUR-MCP-DOMAIN/mcp
```

Not localhost, an IP address, or HTTP.

Complete the OAuth login/consent flow and test:
- search_library
- get_library_item
- list_folders
- get_related_items
- create_library_item
- update_library_item
- move_library_item
- create_folder
- create_share_link
- delete_library_item

### 6. Final live verification
- [ ] Restart the MCP server and verify OAuth sessions persist.
- [ ] Confirm no OAuth token is readable in plaintext from the store.
- [ ] Confirm raw Supabase JWT is rejected by hosted `/mcp`.
- [ ] Confirm read-only OAuth cannot perform write/delete/share.
- [ ] Confirm normal OAuth can perform only its granted scopes.
- [ ] Confirm Claude/cloud can reconnect after a restart.
