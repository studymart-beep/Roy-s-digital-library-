# Safe Merge Instructions

This patch is designed to be merged into the existing GitHub project without deleting the existing application.

## Recommended workflow

Create a branch from the latest `main`, copy the patch files into it, test, then merge the branch into `main`.

### 1. Back up your current branch

From the existing repository:

```powershell
git checkout main
git pull origin main
git branch backup-before-hosted-mcp-fix
```

### 2. Create the fix branch

```powershell
git checkout -b fix/hosted-mcp-production
```

### 3. Copy the patched files

From this ZIP, copy the repository files over the matching files in your cloned repository.

The important changed files are:

```text
src/app.js                         # existing hosted MCP UI retained
src/config.js                      # hosted MCP endpoint
mcp-server/hosted.mjs              # production URL + root status page
mcp-server/lib/oauth.mjs           # offline_access metadata
mcp-server/.env.example            # hosted env example
mcp-server/render.yaml             # Render configuration
scripts/production-smoke.mjs       # public MCP default
DEPLOYMENT.md                      # deployment guidance
MERGE-INSTRUCTIONS.md              # this guide
PATCH-REPORT.md                    # patch summary
```

Do NOT replace the entire repository with the ZIP contents.

Do NOT delete:

```text
src/db.js
src/sync.js
src/supabase.js
styles.css
schema files
service worker
existing Vercel configuration
```

Those are part of the existing application.

### 4. Review before committing

```powershell
git status
git diff -- src/config.js src/app.js mcp-server/hosted.mjs mcp-server/lib/oauth.mjs
```

Also search for accidental development URLs:

```powershell
git grep -n -E "http://localhost|http://127\.0\.0\.1"
```

A localhost fallback may remain inside development/test code. The production hosted server now refuses to use it when `NODE_ENV=production`.

### 5. Commit the patch

```powershell
git add src/config.js src/app.js `
  mcp-server/hosted.mjs mcp-server/lib/oauth.mjs `
  mcp-server/.env.example mcp-server/render.yaml `
  scripts/production-smoke.mjs DEPLOYMENT.md `
  MERGE-INSTRUCTIONS.md PATCH-REPORT.md

git commit -m "fix: harden hosted MCP production configuration"
git push -u origin fix/hosted-mcp-production
```

### 6. Merge into main

Open the GitHub repository and create a Pull Request:

```text
fix/hosted-mcp-production -> main
```

Review the diff, then merge.

Or, if you prefer command-line merging:

```powershell
git checkout main
git pull origin main
git merge --no-ff fix/hosted-mcp-production
git push origin main
```

### 7. Deployment

After `main` changes:

- Vercel should deploy the existing frontend from `main`.
- Render should deploy the MCP service from the MCP service configuration.

The frontend and MCP server are separate deployments.

## Render configuration

Web Service:

```text
Root Directory: mcp-server
Build Command: npm install --omit=dev
Start Command: node hosted.mjs
Health Check Path: /health
```

Environment:

```text
NODE_ENV=production
PUBLIC_URL=https://roys-s-digital-library-mcp.onrender.com
SUPABASE_URL=<your Supabase URL>
SUPABASE_ANON_KEY=<your Supabase anon key>
MCP_OAUTH_STORE_KEY=<32-byte secret>
OAUTH_REDIRECT_ALLOWLIST=https://chatgpt.com,https://claude.ai
```

If ChatGPT gives you an exact callback URL during custom MCP app setup, add that exact callback URL/origin according to the server's allowlist requirements.

## Verify after Render deployment

Open:

```text
https://roys-s-digital-library-mcp.onrender.com/
https://roys-s-digital-library-mcp.onrender.com/health
https://roys-s-digital-library-mcp.onrender.com/ready
https://roys-s-digital-library-mcp.onrender.com/.well-known/oauth-authorization-server
```

The root page should show the public Render URL.

The OAuth discovery response must contain Render URLs, never `127.0.0.1`.

The MCP connector URL is:

```text
https://roys-s-digital-library-mcp.onrender.com/mcp
```

## Important storage architecture

Do NOT move IndexedDB to Render.

The intended architecture is:

```text
Browser
  ├── IndexedDB = local/offline cache + pending writes
  ├── localStorage = small UI preferences such as theme
  │
  └── online sync
          ↓
      Supabase = cloud library data
          ↑
          │
      Render MCP = AI access layer
          ↑
          │
     ChatGPT / Claude / other MCP clients
```

Render filesystem storage is only for the MCP server's encrypted OAuth session store, and it is ephemeral unless a persistent disk is configured.

## Rollback

If anything goes wrong:

```powershell
git checkout main
git reset --hard origin/main
```

Or restore the backup branch:

```powershell
git checkout backup-before-hosted-mcp-fix
```

Do not delete the existing `main` branch.
