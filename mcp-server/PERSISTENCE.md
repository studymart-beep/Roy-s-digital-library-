# Keep MCP sessions alive across Render restarts

## Why connections "expire"
OAuth tokens are stored on disk. On Render **free** instances, the filesystem is wiped on every deploy and often on spin-down unless you attach a **persistent disk**.

## Fix (dashboard)
1. Open your MCP Web Service → **Disks**
2. **Add Disk**
   - Name: `mcp-oauth-data`
   - Mount path: `/var/data`
   - Size: 1 GB
3. **Environment**
   - `MCP_OAUTH_STORE_PATH=/var/data/oauth-store.json`
   - `MCP_OAUTH_STORE_KEY=` (keep your existing 32-byte base64 key — **do not rotate** or all sessions invalidate)
4. Manual Deploy

After this, tokens survive restarts. Users only reconnect if they revoke access or you change the store key.
