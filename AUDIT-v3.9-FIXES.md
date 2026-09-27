# AUDIT-v3.9-FIXES

Follow-up to AUDIT-v3.8-FINAL.md. This covers only the MCP layer
(`mcp-server/`) — the PWA, sync engine, and Supabase schema were not
changed in this pass.

## Fixed

1. **OAuth state no longer lives only in memory.**
   `mcp-server/lib/oauth.mjs` now reads/writes through
   `mcp-server/lib/store.mjs`, a file-backed store with atomic writes.
   Codes, access tokens and refresh tokens survive a server restart.
   Still single-instance only — see the header comment in `store.mjs` for
   what to swap in if this ever runs behind a load balancer.

2. **Refresh tokens rotate, with replay detection.**
   Every `grant_type=refresh_token` call retires the presented refresh
   token and issues a new one. If a retired refresh token is ever
   presented again (a strong signal it was copied/stolen), the entire
   token family from that login — every access and refresh token — is
   revoked immediately, forcing re-authentication.
   Covered by `tests/oauth.mjs` ("replayed refresh token rejected",
   "refresh replay revokes whole token family").

3. **`/oauth/revoke` now checks whether the token is real.**
   `revokeToken()` looks the token up before doing anything, so the
   caller-visible behavior — and any operator logs — reflect whether a
   genuine session was actually torn down, rather than silently
   "succeeding" on arbitrary input. The HTTP response still always
   returns `{revoked: true}` regardless (per RFC 7009, so the endpoint
   can't be used to probe for valid tokens), but `hosted.mjs` now logs
   the real result server-side. Rate limiting was also added to this
   endpoint (previously the only OAuth endpoint without it).

4. **Consent screen shows the actual requested scopes.**
   `authorizePageHtml()` renders a human-readable list (e.g. "Delete
   items and folders in your library") instead of only carrying `scope`
   as an invisible form field.

5. **Missing tools added, for parity with what the app itself can do:**
   - `revoke_share_link` (`library:share`) — the app could revoke a share
     link; MCP could create but never revoke one.
   - `restore_library_item` (`library:write`) — undo a soft-delete.
   - `delete_folder` (`library:delete`) — cascading soft-delete of a
     folder, its nested folders, and everything inside them. This also
     fixes a latent bug relative to the client-side equivalent
     (`softDeleteFolderCascade` in `src/db.js`), which only cascades to
     `prompts` and never touched `library_items`; the server-side version
     cascades to both.

6. **`search_library` no longer silently drops results past 100 rows.**
   Filtering (title/content substring, exact tag match) now happens in
   the Postgres query itself instead of fetching up to 100 rows per
   table and filtering in JavaScript. Added real `offset`/`limit`
   pagination and a `total`/`has_more` in the response so a client can
   tell there's more to page through.

7. **`index.js` (stdio server) no longer duplicates tool logic.**
   It previously reimplemented every tool independently of
   `lib/tools.mjs`, so the two transports (`index.js` for local/stdio,
   `hosted.mjs` for OAuth/remote) could silently drift apart — a bugfix
   or new tool added to one wouldn't reach the other. `index.js` now
   builds a `{sb, user, entitlement}` context and calls the same
   `runTool()` from `lib/tools.mjs` that `hosted.mjs` uses. It keeps its
   own tool metadata (descriptions/schemas) for a better stdio client UX,
   but the business logic is single-sourced.

8. **Tests exercise the real modules.**
   `tests/oauth.mjs` and `tests/security.mjs` previously reimplemented
   PKCE/scope logic inline, so a real bug in `lib/oauth.mjs` or
   `lib/tools.mjs` wouldn't necessarily fail the suite. Both now import
   directly from those files. Verified locally with a stub
   `@supabase/supabase-js` (this sandbox has no network access to install
   the real package) — 20/20 and 12/12 assertions pass. Re-run both with
   the real dependency installed before deploying.

## Deliberately not done

- **Dynamic Client Registration (`/oauth/register`)** — still not
  implemented. Only worth adding if this gets listed in a public MCP
  connector directory; the static `OAUTH_REDIRECT_ALLOWLIST` is simpler
  and no less secure for personal use.
- **`CORS_ORIGIN`** — left as an opt-in env var, unset by default. Remote
  MCP clients (Claude, ChatGPT) call the server directly, not from a
  browser, so this should stay empty unless the PWA itself grows an
  in-browser "ask AI" feature that calls `/mcp` from client-side JS.

## Not covered in this pass

- `src/sync.js` merge/conflict logic (`pullAndMerge`, `shouldPreferCloud`)
  has not been re-audited here.
- Live OAuth + MCP round-trip against a real Supabase user still hasn't
  been run (same gap AUDIT-v3.8-FINAL.md flagged) — this environment has
  no network access to do so. Run `tests/integration.mjs` with
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ROYS_TEST_EMAIL`,
  `ROYS_TEST_PASSWORD` set before considering this production-ready.

## Before deploying

```bash
cd mcp-server && npm install
node ../tests/unit.mjs
node ../tests/security.mjs
node ../tests/oauth.mjs
SUPABASE_URL=... SUPABASE_ANON_KEY=... ROYS_TEST_EMAIL=... ROYS_TEST_PASSWORD=... node ../tests/integration.mjs
```
