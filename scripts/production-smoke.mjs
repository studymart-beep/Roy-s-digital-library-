#!/usr/bin/env node
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/production-smoke.mjs https://mcp.example.com');
  process.exit(2);
}
const checks = [];
async function check(name, url, opts = {}, expected = 200) {
  try {
    const r = await fetch(url, { redirect: 'manual', ...opts });
    const ok = r.status === expected;
    checks.push({ name, ok, status: r.status, url });
    return { r, ok };
  } catch (e) {
    checks.push({ name, ok: false, status: 'ERR', url, error: e.message });
    return { ok: false };
  }
}
await check('HTTPS origin', base, {}, 200).catch(() => {});
await check('health', `${base}/health`);
await check('ready', `${base}/ready`);
const pr = await check('protected-resource metadata', `${base}/.well-known/oauth-protected-resource`);
const as = await check('authorization-server metadata', `${base}/.well-known/oauth-authorization-server`);
await check('unauthenticated MCP returns 401', `${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize', params:{} }) }, 401);
if (pr.ok) {
  const data = await pr.r.json();
  if (data.resource !== `${base}/mcp`) checks.push({ name:'resource metadata points to /mcp', ok:false, detail:data.resource });
  else checks.push({ name:'resource metadata points to /mcp', ok:true });
}
if (as.ok) {
  const data = await as.r.json();
  for (const key of ['authorization_endpoint','token_endpoint']) {
    checks.push({ name:`metadata has ${key}`, ok: typeof data[key] === 'string' && data[key].startsWith(base + '/') });
  }
  checks.push({ name:'PKCE S256 advertised', ok: Array.isArray(data.code_challenge_methods_supported) && data.code_challenge_methods_supported.includes('S256') });
}
let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.status ? ` (${c.status})` : ''}${c.error ? ` — ${c.error}` : ''}`);
  if (!c.ok) failed++;
}
console.log(`\nTOTAL: ${checks.length}  FAILED: ${failed}`);
process.exit(failed ? 1 : 0);
