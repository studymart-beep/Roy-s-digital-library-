# Roy’s Digital Library — MCP Server

Connect ChatGPT / Claude / Cursor / other MCP clients to **your** library.

## Security model

- Every tool runs as **the authenticated user** (Supabase JWT).
- Row Level Security still applies — you cannot read another user’s data.
- **No service-role key** is required for normal tools.
- Secrets live only in this server process / your MCP client config — **never** in the PWA frontend.

## Setup

```bash
cd mcp-server
npm install
```

Copy env:

```bash
cp .env.example .env
# edit SUPABASE_URL + SUPABASE_ANON_KEY
```

### Get your access token

1. Sign in to Roy’s Digital Library in the browser.
2. Open DevTools → Console and run:

```js
(await window.__roysGetAccessToken?.()) || 'open Settings → AI Connections'
```

Or from Settings → **AI Connections** → **Copy access token** (valid until session expires).

### Claude Desktop / Cursor config example

```json
{
  "mcpServers": {
    "roys-prompt-library": {
      "command": "node",
      "args": ["/absolute/path/to/roys-prompt-library/mcp-server/index.js"],
      "env": {
        "SUPABASE_URL": "https://xxxx.supabase.co",
        "SUPABASE_ANON_KEY": "eyJ...",
        "ROYS_ACCESS_TOKEN": "your_user_access_token"
      }
    }
  }
}
```

## Tools

| Tool | Access |
|------|--------|
| `search_library` | Read (paginated: `offset`/`limit`, real Postgres filtering) |
| `get_library_item` | Read |
| `list_folders` | Read |
| `get_related_items` | Read |
| `create_library_item` | Write |
| `update_library_item` | Write |
| `move_library_item` | Write |
| `create_folder` | Write |
| `create_share_link` | Share |
| `revoke_share_link` | Share |
| `restore_library_item` | Write |
| `delete_library_item` | Delete (destructive, requires `confirm: true`) |
| `delete_folder` | Delete (destructive, cascades to nested folders/items, requires `confirm: true`) |

`index.js` (stdio) and `hosted.mjs` (OAuth/remote) both call the same
`lib/tools.mjs` implementations — there is only one copy of each tool's
logic, so a fix or new tool added there is available from both transports.

## Hosted MCP (OAuth) — what changed in v3.9

- Authorization codes, access tokens and refresh tokens now persist to a
  file (`MCP_OAUTH_STORE_PATH`, default `./data/oauth-store.json`) instead
  of living only in memory, so a server restart no longer logs out every
  connected client. This is still single-instance only — see the comment
  at the top of `lib/store.mjs` if you need to run more than one process.
- Refresh tokens rotate on every use. If a refresh token is ever presented
  a second time (a sign it was stolen and used by someone else), the whole
  login session — every token issued from it — is revoked immediately and
  the client must sign in again.
- The consent screen at `/oauth/authorize` now lists the actual scopes
  being requested, not just a generic "allow access" message.

## Example prompts for the AI

- “Search my library for outreach prompts”
- “Save this as research under Market Research”
- “Turn that research into a strategy and save it”
- “Create three product prompts from this strategy”


## Remote cloud deployment

For Claude/ChatGPT remote MCP connections, deploy `hosted.mjs` behind a public HTTPS URL. The hosting platform may terminate TLS while Node listens internally on `PORT`. Set:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=...
PUBLIC_URL=https://YOUR-MCP-DOMAIN.example/mcp-parent
OAUTH_REDIRECT_ALLOWLIST=https://claude.ai,https://chatgpt.com
MCP_OAUTH_STORE_PATH=/persistent/roys-mcp/oauth-store.json
MCP_OAUTH_STORE_KEY=<32-byte-secret>
```

The MCP endpoint is `https://YOUR-MCP-DOMAIN.example/mcp`. The server publishes OAuth Protected Resource Metadata and Authorization Server Metadata so remote MCP clients can discover the authorization flow.

Do not use a plain `http://` public URL. Local loopback HTTP remains allowed for development only.
