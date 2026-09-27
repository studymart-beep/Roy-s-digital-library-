# Roy's Digital Library

Personal prompt & asset library (PWA) with Supabase sync, offline support, sharing, and MCP tools.

## Quick start

1. Open this folder with any static host (or `npx serve .`).
2. Supabase is configured in `src/config.js` (Project URL + **anon** key only).
3. Run SQL migrations in Supabase **SQL Editor** (order below).
4. Auth → enable Email provider. Create Storage bucket `prompt-images` (private).

### SQL order

1. `schema.sql`
2. `schema_share.sql`
3. `schema_library.sql`
4. `schema_v35_hardening.sql`
5. `schema_v36_production.sql`

### MCP (optional)

```bash
cd mcp-server && npm install
# Local STDIO: set SUPABASE_URL, SUPABASE_ANON_KEY, ROYS_ACCESS_TOKEN
node index.js
```

## Security

- Only the **anon** key belongs in the browser.
- Never commit the **service_role** key.
