/**
 * OAuth 2.1 Authorization Server (minimal, production-oriented)
 * for Roy's Digital Library MCP.
 *
 * Flow: Authorization Code + PKCE (S256) only.
 * Identity: user authenticates via Supabase email/password on authorize page;
 * issued access tokens are opaque server-side tokens bound to that user_id.
 * Never accept client-supplied user_id as authority.
 *
 * v3.9 changes:
 *   - Codes/tokens/refresh tokens are now file-backed (lib/store.mjs) instead
 *     of in-memory Maps, so they survive a server restart.
 *   - Refresh tokens rotate on every use. Each authorization grant has a
 *     familyId; redeeming a refresh token retires it and issues a new one
 *     in the same family. If a retired refresh token is presented again
 *     (replay/theft), the entire family — every access and refresh token
 *     from that login — is revoked immediately.
 *   - /oauth/revoke only revokes tokens that actually exist in the store
 *     (previously it would happily "revoke" a random guessed string, which
 *     is harmless but not meaningful; now it reports whether anything was
 *     actually revoked so callers/logs can tell).
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { getStore } from './store.mjs';

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// How long a spent refresh token is remembered purely so a replay of it can
// be detected and treated as theft, rather than just becoming a generic
// "invalid_grant" once it falls out of the store.
const USED_REFRESH_MEMORY_MS = REFRESH_TTL_MS;

const SCOPE_LABELS = {
  'library:read': 'Read your prompts, notes and folders',
  'library:write': 'Create, edit and move items in your library',
  'library:delete': 'Delete items and folders in your library',
  'library:share': 'Create and revoke public share links',
  openid: 'Confirm your identity',
};

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Decode a JWT's `exp` claim (seconds since epoch) without verifying it —
 *  verification happens server-side via Supabase; this is only used to
 *  decide whether it's worth proactively refreshing before use. */
function jwtExpMs(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function sha256b64url(str) {
  return createHash('sha256').update(str).digest('base64url');
}

function now() {
  return Date.now();
}

function store() {
  return getStore();
}

export function oauthMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['library:read', 'library:write', 'library:delete', 'library:share', 'openid'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
  };
}

export function validateRedirectUri(uri, allowedList) {
  if (!uri || typeof uri !== 'string') return false;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    return false;
  }
  if (!allowedList || allowedList.length === 0) {
    // Dev default: localhost only if no allowlist configured
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  }
  return allowedList.some((allowed) => {
    try {
      const a = new URL(allowed);
      return a.origin === u.origin && uri.startsWith(allowed.replace(/\*$/, ''));
    } catch {
      return uri === allowed || uri.startsWith(allowed);
    }
  });
}

export function parseScopes(scopeStr) {
  const allowed = new Set(['library:read', 'library:write', 'library:delete', 'library:share', 'openid']);
  const parts = String(scopeStr || 'library:read library:write library:share library:delete')
    .split(/\s+/).filter(Boolean);
  const out = parts.filter((s) => allowed.has(s));
  if (!out.includes('library:read')) out.unshift('library:read');
  return out;
}

/** Human-readable labels for a scope list, for the consent screen. */
export function describeScopes(scopes) {
  return (scopes || []).map((s) => ({ scope: s, label: SCOPE_LABELS[s] || s }));
}

/**
 * After user proves identity via Supabase password on authorize form,
 * create a one-time authorization code.
 */
export function issueAuthorizationCode({
  clientId,
  redirectUri,
  codeChallenge,
  codeChallengeMethod,
  scope,
  state,
  userId,
  email,
  supabaseAccessToken,
  supabaseRefreshToken,
}) {
  if (codeChallengeMethod !== 'S256') {
    const e = new Error('Only S256 PKCE is supported');
    e.code = 'invalid_request';
    throw e;
  }
  if (!codeChallenge || codeChallenge.length < 43) {
    const e = new Error('code_challenge required');
    e.code = 'invalid_request';
    throw e;
  }
  const code = b64url(randomBytes(32));
  store().set('codes', code, {
    clientId: clientId || 'roys-mcp',
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: parseScopes(scope),
    state,
    userId,
    email,
    supabaseAccessToken: supabaseAccessToken || null,
    supabaseRefreshToken: supabaseRefreshToken || null,
    expiresAt: now() + CODE_TTL_MS,
    used: false,
  });
  return code;
}

function issueTokenPair(rec, familyId) {
  const accessToken = b64url(randomBytes(32));
  const refreshToken = b64url(randomBytes(32));
  const expiresIn = Math.floor(ACCESS_TTL_MS / 1000);
  store().set('tokens', accessToken, {
    userId: rec.userId,
    email: rec.email,
    scope: rec.scope,
    clientId: rec.clientId,
    familyId,
    supabaseAccessToken: rec.supabaseAccessToken || null,
    supabaseRefreshToken: rec.supabaseRefreshToken || null,
    expiresAt: now() + ACCESS_TTL_MS,
    type: 'access',
  });
  store().set('refreshTokens', refreshToken, {
    userId: rec.userId,
    email: rec.email,
    scope: rec.scope,
    clientId: rec.clientId,
    familyId,
    supabaseAccessToken: rec.supabaseAccessToken || null,
    supabaseRefreshToken: rec.supabaseRefreshToken || null,
    expiresAt: now() + REFRESH_TTL_MS,
  });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: rec.scope.join(' '),
  };
}

export function exchangeAuthorizationCode({
  code,
  redirectUri,
  codeVerifier,
  clientId,
}) {
  store().gc();
  const rec = store().get('codes', code);
  if (!rec || rec.used || rec.expiresAt < now()) {
    const e = new Error('Invalid or expired authorization code');
    e.code = 'invalid_grant';
    throw e;
  }
  if (rec.redirectUri !== redirectUri) {
    const e = new Error('redirect_uri mismatch');
    e.code = 'invalid_grant';
    throw e;
  }
  if (clientId && rec.clientId && clientId !== rec.clientId) {
    const e = new Error('client_id mismatch');
    e.code = 'invalid_grant';
    throw e;
  }
  const expected = sha256b64url(codeVerifier || '');
  const a = Buffer.from(expected);
  const b = Buffer.from(rec.codeChallenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const e = new Error('PKCE verification failed');
    e.code = 'invalid_grant';
    throw e;
  }
  store().delete('codes', code);

  // A familyId ties every token issued from this single login together, so
  // that detecting a replayed refresh token lets us kill the whole chain.
  const familyId = b64url(randomBytes(16));
  return issueTokenPair(rec, familyId);
}

/**
 * Redeem a refresh token for a new access token, rotating the refresh
 * token in the process. If the presented refresh token has already been
 * redeemed once before (replay), the entire token family is revoked and
 * the caller must re-authenticate from scratch.
 */
export function refreshAccessToken({ refreshToken, clientId }) {
  store().gc();
  const rec = store().get('refreshTokens', refreshToken);

  if (!rec) {
    // Was this token already used once? That's a replay — kill the family.
    const used = store().get('usedRefreshTokens', refreshToken);
    if (used) {
      store().revokeFamily(used.familyId);
      const e = new Error('Refresh token reuse detected — session revoked, please sign in again');
      e.code = 'invalid_grant';
      throw e;
    }
    const e = new Error('Invalid refresh token');
    e.code = 'invalid_grant';
    throw e;
  }
  if (rec.expiresAt < now()) {
    store().delete('refreshTokens', refreshToken);
    const e = new Error('Refresh token expired');
    e.code = 'invalid_grant';
    throw e;
  }
  if (clientId && rec.clientId && clientId !== rec.clientId) {
    const e = new Error('client_id mismatch');
    e.code = 'invalid_grant';
    throw e;
  }

  // Retire this refresh token and remember it briefly for replay detection.
  store().delete('refreshTokens', refreshToken);
  store().set('usedRefreshTokens', refreshToken, {
    familyId: rec.familyId,
    expiresAt: now() + USED_REFRESH_MEMORY_MS,
  });

  return issueTokenPair(rec, rec.familyId);
}

/**
 * Revoke a token. Looks the token up first so we know (and can report)
 * whether it was a real, currently-valid token, rather than blindly
 * "revoking" arbitrary input. Revoking any token in a family revokes the
 * whole family (full logout for that login), matching RFC 7009 guidance
 * for refresh tokens and applied uniformly here for simplicity.
 */
export function revokeToken(token) {
  if (!token) return { revoked: false };
  const accessRec = store().get('tokens', token);
  const refreshRec = store().get('refreshTokens', token);
  const rec = accessRec || refreshRec;
  if (!rec) return { revoked: false };
  store().revokeFamily(rec.familyId);
  return { revoked: true };
}

/**
 * Given an opaque-token record, make sure the underlying Supabase JWT it
 * carries (used so Postgres RLS sees a real auth.uid()) is still valid —
 * Supabase access tokens live ~1h, well inside the OAuth access token's
 * own TTL, so without this every tool call would start failing RLS checks
 * long before the OAuth token itself expired. Refreshes and persists the
 * new pair back into the store when the current one is expired or about
 * to be, using the Supabase refresh token captured at login.
 */
async function ensureFreshSupabaseToken(tokenKey, rec, { supabaseUrl, supabaseAnonKey }) {
  const SKEW_MS = 60_000;
  const exp = jwtExpMs(rec.supabaseAccessToken);
  if (rec.supabaseAccessToken && exp - SKEW_MS > now()) {
    return rec.supabaseAccessToken; // still good
  }
  if (!rec.supabaseRefreshToken || !supabaseUrl || !supabaseAnonKey) {
    // Nothing we can do — caller will fall back to whatever it has (or none).
    return rec.supabaseAccessToken || null;
  }
  try {
    const sb = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.refreshSession({ refresh_token: rec.supabaseRefreshToken });
    if (error || !data?.session?.access_token) throw error || new Error('No session on refresh');
    const newAccess = data.session.access_token;
    const newRefresh = data.session.refresh_token || rec.supabaseRefreshToken;
    rec.supabaseAccessToken = newAccess;
    rec.supabaseRefreshToken = newRefresh;
    store().set('tokens', tokenKey, rec);
    return newAccess;
  } catch (err) {
    // Supabase session couldn't be refreshed (e.g. revoked). Fall back to
    // the stale token — the downstream RLS-scoped query will simply fail
    // with an auth error, which is the correct, safe outcome.
    return rec.supabaseAccessToken || null;
  }
}

/**
 * Resolve a bearer token presented to the PUBLIC HOSTED MCP endpoints
 * (/mcp, /mcp/tools/:name) → { userId, email, scope[] }.
 *
 * This is the only bearer resolution the hosted server may use. It accepts
 * *only* opaque access tokens this OAuth server itself issued after PKCE +
 * user consent — never a raw Supabase JWT.
 *
 * Why that distinction matters: a Supabase JWT proves who the user is to
 * Supabase, but it says nothing about which third-party client is
 * presenting it or what that client was actually granted during consent.
 * If the hosted endpoint honored a raw JWT, anyone who could get a user's
 * Supabase session token — e.g. by lifting it from the browser the way an
 * XSS or a leaky third-party integration might — could call every
 * read/write/delete/share tool with no consent screen and no scope limits.
 * Routing every hosted call through an opaque, scope-bound, revocable
 * token is what makes the consent screen (and OAUTH_REDIRECT_ALLOWLIST,
 * PKCE, refresh-token rotation, etc.) actually mean something.
 */
export async function resolveOAuthBearer(token, { supabaseUrl, supabaseAnonKey } = {}) {
  if (!token) {
    const e = new Error('Missing token');
    e.code = 'UNAUTHORIZED';
    throw e;
  }
  store().gc();
  const opaque = store().get('tokens', token);
  if (!opaque) {
    // Deliberately do NOT fall back to treating this as a Supabase JWT here
    // (see the doc comment above) — including when it looks like one.
    const e = new Error('Invalid token');
    e.code = 'UNAUTHORIZED';
    throw e;
  }
  if (opaque.expiresAt < now()) {
    store().delete('tokens', token);
    const e = new Error('Token expired');
    e.code = 'UNAUTHORIZED';
    throw e;
  }
  const freshSupabaseToken = await ensureFreshSupabaseToken(token, opaque, { supabaseUrl, supabaseAnonKey });
  return {
    userId: opaque.userId,
    email: opaque.email,
    scope: opaque.scope,
    source: 'oauth',
    supabaseAccessToken: freshSupabaseToken,
  };
}

/**
 * Resolve a bearer token for the LOCAL / STDIO MCP server ONLY.
 *
 * The local server (mcp-server/index.js) runs on the operator's own
 * machine and is configured directly with that user's own Supabase access
 * token (ROYS_ACCESS_TOKEN) — there is no separate third-party client to
 * grant scoped consent to, so trusting the raw JWT there is the intended
 * local model, not a bypass of the hosted one. This function must never be
 * wired up to a public network listener; hosted.mjs must use
 * resolveOAuthBearer() instead.
 */
export async function resolveLocalBearer(token, { supabaseUrl, supabaseAnonKey }) {
  if (!token) {
    const e = new Error('Missing token');
    e.code = 'UNAUTHORIZED';
    throw e;
  }
  if (token.split('.').length === 3 && supabaseUrl && supabaseAnonKey) {
    const sb = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user?.id) {
      const e = new Error('Invalid token');
      e.code = 'UNAUTHORIZED';
      throw e;
    }
    return {
      userId: data.user.id,
      email: data.user.email,
      scope: ['library:read', 'library:write', 'library:delete', 'library:share'],
      source: 'supabase_jwt',
      supabaseAccessToken: token,
    };
  }
  const e = new Error('Invalid token');
  e.code = 'UNAUTHORIZED';
  throw e;
}

export async function loginWithPassword(supabaseUrl, supabaseAnonKey, email, password) {
  const sb = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data?.user?.id) {
    const e = new Error(error?.message || 'Login failed');
    e.code = 'access_denied';
    throw e;
  }
  return {
    userId: data.user.id,
    email: data.user.email,
    accessToken: data.session?.access_token,
    refreshToken: data.session?.refresh_token,
  };
}

export function authorizePageHtml({ clientId, redirectUri, state, scope, codeChallenge, error }) {
  const err = error ? `<p style="color:#c00">${String(error).replace(/</g, '')}</p>` : '';
  const scopeList = describeScopes(parseScopes(scope));
  const scopeHtml = scopeList
    .map((s) => `<li><code>${esc(s.scope)}</code> — ${esc(s.label)}</li>`)
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Authorize — Roy's Digital Library</title>
<style>
body{font-family:system-ui,sans-serif;background:#faf5ea;color:#2b2716;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fffdf9;border:1px solid #e9dfc7;border-radius:20px;padding:28px;max-width:400px;width:92%;box-shadow:0 10px 34px rgba(120,96,40,0.14)}
h1{font-family:Georgia,serif;font-size:1.2rem;margin:0 0 8px;color:#b8901f}
p{color:#6b6250;font-size:.9rem;line-height:1.45}
label{display:block;margin:12px 0 4px;font-size:.8rem;color:#6b6250}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #e9dfc7;background:#fbf6eb;color:#2b2716}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:24px;background:linear-gradient(145deg,#f5d04a,#c9a227);color:#2b2716;font-weight:700;cursor:pointer}
.meta{font-size:.75rem;color:#948a72;margin-top:12px;word-break:break-all}
.scopes{list-style:none;margin:8px 0 0;padding:0;font-size:.82rem;color:#6b6250}
.scopes li{margin:4px 0}
.scopes code{color:#b8901f}
</style></head><body><div class="card">
<h1>Roy's Digital Library</h1>
<p>Sign in to let <strong>${esc(clientId || 'this client')}</strong> access your library. It is asking for:</p>
<ul class="scopes">${scopeHtml}</ul>
${err}
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${esc(clientId)}"/>
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}"/>
<input type="hidden" name="state" value="${esc(state || '')}"/>
<input type="hidden" name="scope" value="${esc(scope || '')}"/>
<input type="hidden" name="code_challenge" value="${esc(codeChallenge)}"/>
<input type="hidden" name="code_challenge_method" value="S256"/>
<input type="hidden" name="response_type" value="code"/>
<label>Email</label><input type="email" name="email" required autocomplete="username"/>
<label>Password</label><input type="password" name="password" required autocomplete="current-password"/>
<button type="submit">Authorize</button>
</form>
<p class="meta">Client: ${esc(clientId || 'roys-mcp')}<br/>Redirect: ${esc(redirectUri)}</p>
</div></body></html>`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
