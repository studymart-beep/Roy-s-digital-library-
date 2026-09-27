# Deployment — v3.9.1

## Supabase SQL (full order)

Run in SQL Editor, in order, or paste `ALL_SCHEMAS.sql` once:

1. schema.sql
2. schema_share.sql
3. schema_library.sql
4. schema_v35_hardening.sql
5. schema_v36_production.sql
6. schema_v39_security.sql

## Frontend (Vercel)

- `src/config.js` already has Project URL + anon key.
- Host static files on HTTPS (current: https://roy-s-digital-library.vercel.app/).
- Settings → AI Connections points at the **hosted** MCP endpoint.

## Hosted MCP on Render (required for ChatGPT / Claude remote)

**Public URL:** `https://roys-s-digital-library-mcp.onrender.com`  
**MCP endpoint:** `https://roys-s-digital-library-mcp.onrender.com/mcp`

### Why you saw localhost

`hosted.mjs` defaults `PUBLIC_URL` to `http://127.0.0.1:$PORT` when the env var is unset.  
OAuth metadata and the root JSON then advertise localhost. Fix by setting env on Render.

### Render Web Service settings

| Setting | Value |
|---------|--------|
| Root Directory | `mcp-server` |
| Build Command | `npm install --omit=dev` |
| Start Command | `node hosted.mjs` |
| Health Check Path | `/health` |

### Environment variables (Render Dashboard → Environment)

```text
PUBLIC_URL=https://roys-s-digital-library-mcp.onrender.com
SUPABASE_URL=https://koqahvdarauyhehsokqw.supabase.co
SUPABASE_ANON_KEY=<your anon key>
MCP_OAUTH_STORE_KEY=<openssl rand -base64 32>
OAUTH_REDIRECT_ALLOWLIST=https://chatgpt.com,https://claude.ai,https://claude.ai/api/mcp/auth_callback
MCP_OAUTH_STORE_PATH=./data/oauth-store.json
NODE_ENV=production
```

After deploy, verify:

```bash
curl https://roys-s-digital-library-mcp.onrender.com/health
curl https://roys-s-digital-library-mcp.onrender.com/ready
curl https://roys-s-digital-library-mcp.onrender.com/
# mcp field must show https://roys-s-digital-library-mcp.onrender.com/mcp  (NOT localhost)
```

If curl returns `x-render-routing: no-server` / plain "Not Found", the service name is not running — create or restart the Web Service with the settings above.

### Connect AI clients

- **ChatGPT / Claude (remote MCP):** add custom connector URL  
  `https://roys-s-digital-library-mcp.onrender.com/mcp`  
  Complete OAuth when prompted.
- **Cursor:** `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "roys-library": {
      "url": "https://roys-s-digital-library-mcp.onrender.com/mcp"
    }
  }
}
```

### Local stdio (optional, developers only)

```bash
cd mcp-server && npm install
export SUPABASE_URL=... SUPABASE_ANON_KEY=... ROYS_ACCESS_TOKEN=...
node index.js
```

## Security

Never put service_role in frontend or MCP tool identity env.


## Hosted MCP architecture (production)

The browser app keeps its offline/local cache in IndexedDB. Do **not** replace IndexedDB with
Render storage. Supabase is the cloud data layer; Render hosts only the remote MCP HTTP server.

Production MCP endpoint:

`https://roys-s-digital-library-mcp.onrender.com/mcp`

The Render service must have:

- `PUBLIC_URL=https://roys-s-digital-library-mcp.onrender.com`
- `SUPABASE_URL=<your Supabase project URL>`
- `SUPABASE_ANON_KEY=<your Supabase anon key>`
- `MCP_OAUTH_STORE_KEY=<32-byte secret>`
- `OAUTH_REDIRECT_ALLOWLIST=https://chatgpt.com,https://claude.ai`

The hosted server now fails fast in production if `PUBLIC_URL` is missing, instead of silently
advertising `127.0.0.1`.

For ChatGPT, use the exact callback URL shown by the ChatGPT app/MCP setup flow if the provider
requires an explicit callback registration. Do not invent a generic callback URL.
