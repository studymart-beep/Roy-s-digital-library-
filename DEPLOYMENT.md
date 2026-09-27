# Deployment — v3.8

## Supabase SQL (full order)

Run in SQL Editor, in order, or paste `ALL_SCHEMAS.sql` once:

1. schema.sql
2. schema_share.sql
3. schema_library.sql
4. schema_v35_hardening.sql
5. schema_v36_production.sql
6. schema_v39_security.sql

## Frontend

Set `src/config.js` to Project URL + anon key only.

Host static files on HTTPS.

## Hosted MCP
Remote MCP clients require a public HTTPS origin. `PUBLIC_URL` must be the exact HTTPS URL users will connect to. Your Node process may listen on plain HTTP behind the hosting platform's TLS proxy.


```bash
cd mcp-server
npm install
export SUPABASE_URL=https://xxxx.supabase.co
export SUPABASE_ANON_KEY=eyJ...
export PUBLIC_URL=https://mcp.yourdomain.com
export OAUTH_REDIRECT_ALLOWLIST=https://chatgpt.com,https://claude.ai,http://127.0.0.1:3000/callback
export CORS_ORIGIN=https://your-app.com
export PORT=8787
node hosted.mjs
```

### OAuth client flow

1. GET `/.well-known/oauth-authorization-server`
2. GET `/oauth/authorize?response_type=code&client_id=roys-mcp&redirect_uri=...&code_challenge=...&code_challenge_method=S256&state=...&scope=library:read library:write`
3. User signs in (Supabase email/password)
4. Redirect with `?code=`
5. POST `/oauth/token` with `grant_type=authorization_code&code=&redirect_uri=&code_verifier=&client_id=`
6. Call MCP: `POST /mcp` with `Authorization: Bearer <access_token>`

### MCP JSON-RPC examples

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_library","arguments":{"query":"outreach","limit":5}}}
```

## Security

Never put service_role in frontend or MCP env for tool execution identity.

### Remote MCP discovery

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `POST /mcp`

Unauthenticated MCP requests receive HTTP 401 with a `WWW-Authenticate` challenge pointing to the protected-resource metadata.
