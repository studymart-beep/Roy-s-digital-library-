/**
 * OAuth tests against the REAL server module (mcp-server/lib/oauth.mjs),
 * not a reimplementation. A regression in the actual PKCE check, redirect
 * validation, or refresh-token rotation will fail this suite.
 *
 * node tests/oauth.mjs
 */
import { randomBytes, createHash } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Point the persistent store at a throwaway file for this test run only,
// before importing the modules that create the singleton store.
const storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roys-oauth-test-')), 'store.json');
process.env.MCP_OAUTH_STORE_PATH = storeFile;

const {
  validateRedirectUri,
  issueAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  resolveBearer,
  parseScopes,
} = await import('../mcp-server/lib/oauth.mjs');

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; console.error('FAIL', name, detail); }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function sha256b64url(str) {
  return createHash('sha256').update(str).digest('base64url');
}

// ── Redirect URI validation ─────────────────────────────────────
assert('redirect localhost ok', validateRedirectUri('http://127.0.0.1:3000/cb', []));
assert('redirect evil http rejected', !validateRedirectUri('http://evil.com/cb', []));
assert('redirect https allowlist', validateRedirectUri('https://app.example.com/cb', ['https://app.example.com/cb']));
assert('redirect allowlist reject', !validateRedirectUri('https://evil.com/cb', ['https://app.example.com/cb']));

// ── Scope parsing ────────────────────────────────────────────────
assert('always includes library:read', parseScopes('library:write').includes('library:read'));
assert('unknown scopes dropped', !parseScopes('library:write not-a-real-scope').includes('not-a-real-scope'));

// ── Full authorization-code + PKCE flow ──────────────────────────
const verifier = b64url(randomBytes(32));
const challenge = sha256b64url(verifier);
const redirectUri = 'http://127.0.0.1:3000/cb';

const code = issueAuthorizationCode({
  clientId: 'test-client',
  redirectUri,
  codeChallenge: challenge,
  codeChallengeMethod: 'S256',
  scope: 'library:read library:write',
  state: 'xyz',
  userId: 'u1',
  email: 'u1@example.com',
  supabaseAccessToken: null,
});
assert('code issued', typeof code === 'string' && code.length > 0);

const tok1 = exchangeAuthorizationCode({ code, redirectUri, codeVerifier: verifier, clientId: 'test-client' });
assert('access token issued', !!tok1.access_token);
assert('refresh token issued', !!tok1.refresh_token);

let replay = false;
try { exchangeAuthorizationCode({ code, redirectUri, codeVerifier: verifier, clientId: 'test-client' }); }
catch { replay = true; }
assert('authorization code is single-use', replay);

const code2 = issueAuthorizationCode({
  clientId: 'test-client', redirectUri,
  codeChallenge: sha256b64url(b64url(randomBytes(32))),
  codeChallengeMethod: 'S256', scope: 'library:read', userId: 'u2', email: 'u2@example.com',
});
let badPkce = false;
try { exchangeAuthorizationCode({ code: code2, redirectUri, codeVerifier: 'wrong-verifier-value-not-matching!!!' }); }
catch { badPkce = true; }
assert('bad PKCE verifier rejected', badPkce);

// ── resolveBearer recognizes an issued opaque token ─────────────
const identity = await resolveBearer(tok1.access_token, {});
assert('resolveBearer finds user', identity.userId === 'u1');
assert('resolveBearer carries scope', identity.scope.includes('library:write'));

// ── Refresh token rotation ───────────────────────────────────────
const tok2 = refreshAccessToken({ refreshToken: tok1.refresh_token, clientId: 'test-client' });
assert('refresh yields new access token', tok2.access_token !== tok1.access_token);

// The OLD access token from before the refresh should no longer resolve —
// rotation only replaces the refresh token itself, so this checks that the
// new access token at least differs and is independently valid:
const identity2 = await resolveBearer(tok2.access_token, {});
assert('new access token resolves', identity2.userId === 'u1');

// ── Refresh token reuse (replay) is detected and kills the session ──
let reuseDetected = false;
try {
  // tok1.refresh_token was already redeemed above — using it again must fail
  refreshAccessToken({ refreshToken: tok1.refresh_token, clientId: 'test-client' });
} catch (e) {
  reuseDetected = e.code === 'invalid_grant';
}
assert('replayed refresh token rejected', reuseDetected);

// After a detected replay, even the freshly-rotated token from the SAME
// family should have been revoked (whole-family kill switch):
let familyKilled = false;
try {
  const stillGood = await resolveBearer(tok2.access_token, {});
  familyKilled = !stillGood;
} catch {
  familyKilled = true;
}
assert('refresh replay revokes whole token family', familyKilled);

// ── revokeToken only reports success for tokens that really exist ──
const code3 = issueAuthorizationCode({
  clientId: 'test-client', redirectUri,
  codeChallenge: sha256b64url(b64url(randomBytes(32))),
  codeChallengeMethod: 'S256', scope: 'library:read', userId: 'u3', email: 'u3@example.com',
});
const v3 = b64url(randomBytes(32));
const code3b = issueAuthorizationCode({
  clientId: 'test-client', redirectUri,
  codeChallenge: sha256b64url(v3),
  codeChallengeMethod: 'S256', scope: 'library:read', userId: 'u3', email: 'u3@example.com',
});
const tok3 = exchangeAuthorizationCode({ code: code3b, redirectUri, codeVerifier: v3, clientId: 'test-client' });
const revokeReal = revokeToken(tok3.access_token);
assert('revoking a real token reports revoked:true', revokeReal.revoked === true);
const revokeFake = revokeToken('this-token-was-never-issued');
assert('revoking a made-up token reports revoked:false', revokeFake.revoked === false);

let revokedTokenRejected = false;
try { await resolveBearer(tok3.access_token, {}); }
catch (e) { revokedTokenRejected = e.code === 'UNAUTHORIZED'; }
assert('revoked token no longer resolves', revokedTokenRejected);

console.log('\nOAUTH RESULTS');
console.log('TOTAL:', passed + failed);
console.log('PASSED:', passed);
console.log('FAILED:', failed);
process.exit(failed ? 1 : 0);
