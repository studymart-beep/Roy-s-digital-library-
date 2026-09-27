/**
 * Live Supabase integration — requires env vars. Skips cleanly otherwise.
 */
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
const email = process.env.ROYS_TEST_EMAIL;
const password = process.env.ROYS_TEST_PASSWORD;

if (!url || !key || !email || !password) {
  console.log('INTEGRATION RESULTS');
  console.log('TOTAL: 0');
  console.log('PASSED: 0');
  console.log('FAILED: 0');
  console.log('SKIPPED: all (missing SUPABASE_URL / SUPABASE_ANON_KEY / ROYS_TEST_EMAIL / ROYS_TEST_PASSWORD)');
  process.exit(0);
}

const { createClient } = await import('@supabase/supabase-js');
const { clientForToken, resolveUser, runTool, getUserEntitlement } = await import('../mcp-server/lib/tools.mjs');

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; console.error('FAIL', name, detail); }
}

const admin = createClient(url, key);
const { data: auth, error: authErr } = await admin.auth.signInWithPassword({ email, password });
assert('sign in', !authErr && !!auth?.session, authErr?.message);
if (!auth?.session) {
  console.log('INTEGRATION RESULTS');
  console.log('TOTAL:', passed + failed, 'PASSED:', passed, 'FAILED:', failed);
  process.exit(1);
}

const token = auth.session.access_token;
const sb = clientForToken(url, key, token);
const user = await resolveUser(sb, token);
assert('resolve user', !!user?.id);
const ctx = { sb, user, entitlement: await getUserEntitlement(user.id) };
const folders = await runTool('list_folders', {}, ctx);
assert('list folders', Array.isArray(folders.folders));
let delBlocked = false;
try { await runTool('delete_library_item', { id: 'nope', confirm: false }, ctx); }
catch (e) { delBlocked = e.code === 'VALIDATION_ERROR'; }
assert('delete confirm required', delBlocked);

console.log('INTEGRATION RESULTS');
console.log('TOTAL:', passed + failed);
console.log('PASSED:', passed);
console.log('FAILED:', failed);
process.exit(failed ? 1 : 0);
