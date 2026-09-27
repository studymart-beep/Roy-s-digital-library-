# Roy's Digital Library v3.9.1 — Hosted MCP Patch

## Changes made

1. **Production PUBLIC_URL hardening**
   - `mcp-server/hosted.mjs` no longer silently runs with a localhost public URL in production.
   - If `NODE_ENV=production` and `PUBLIC_URL` is missing/loopback, the server exits with a clear configuration error.
   - Development still supports a loopback fallback.

2. **Hosted MCP root page**
   - `GET /` now displays a small human-readable service status page.
   - `GET /mcp` remains the MCP endpoint.
   - OAuth discovery and protected-resource metadata remain JSON endpoints.

3. **OAuth refresh support**
   - Added `offline_access` to advertised/accepted scopes.
   - This aligns the server metadata with clients that use offline refresh-token connectivity.

4. **Render environment examples**
   - Production `.env.example` no longer encourages a localhost callback in the hosted allowlist.
   - Render OAuth store path uses `/tmp/oauth-store.json` by default; a Render Persistent Disk should be used if you need sessions to survive service restarts.

5. **IndexedDB preserved**
   - `src/db.js` was intentionally NOT replaced.
   - Browser IndexedDB remains the offline/local source of truth.
   - Supabase remains the cloud synchronization layer.
   - Render remains the hosted MCP API layer.

6. **Production smoke default**
   - `scripts/production-smoke.mjs` defaults to the public Render MCP service.

## Validation

- JavaScript syntax checks passed for the modified source files.
- The full dependency-based OAuth test could not be executed in this environment because npm dependency installation timed out / network resolution is unavailable here.
- No secrets were added to the patch.

## Production MCP URL

`https://roys-s-digital-library-mcp.onrender.com/mcp`

## Required Render variables

- `NODE_ENV=production`
- `PUBLIC_URL=https://roys-s-digital-library-mcp.onrender.com`
- `SUPABASE_URL=<your Supabase URL>`
- `SUPABASE_ANON_KEY=<your Supabase anon key>`
- `MCP_OAUTH_STORE_KEY=<32-byte secret>`
- `OAUTH_REDIRECT_ALLOWLIST=https://chatgpt.com,https://claude.ai`

For ChatGPT or another client that provides an exact OAuth callback URL, register the exact callback URL shown by that client. Do not invent a callback path.
