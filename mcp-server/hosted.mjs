/**
 * Roy's Digital Library — Hosted MCP (v3.9.1)
 *
 * - OAuth 2.1 Authorization Code + PKCE (S256)
 * - MCP Streamable HTTP: POST /mcp (JSON-RPC)
 * - Shared tools: lib/tools.mjs
 * - Identity: OAuth-issued access token only (resolveOAuthBearer)
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  TOOL_SCOPES,
  runTool,
  getUserEntitlement,
  makeError,
} from './lib/tools.mjs';
import {
  oauthMetadata,
  validateRedirectUri,
  issueAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  resolveOAuthBearer,
  loginWithPassword,
  authorizePageHtml,
} from './lib/oauth.mjs';

const PORT = Number(process.env.PORT || 8787);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CONFIGURED_PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const PUBLIC_URL = CONFIGURED_PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const IS_LOOPBACK_PUBLIC_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(PUBLIC_URL);

if (!IS_LOOPBACK_PUBLIC_URL && !PUBLIC_URL.startsWith('https://')) {
  throw new Error('PUBLIC_URL must use https:// for hosted deployments');
}
if (IS_PRODUCTION && IS_LOOPBACK_PUBLIC_URL) {
  throw new Error(
    'PUBLIC_URL is required in production and must be the Render HTTPS origin. ' +
      'Set PUBLIC_URL=https://roy-s-digital-library.onrender.com'
  );
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const OAUTH_REDIRECT_ALLOWLIST = (process.env.OAUTH_REDIRECT_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** CSP for OAuth HTML pages — form-action * required so Claude/ChatGPT in-app browsers can POST */
const OAUTH_HTML_CSP =
  "default-src 'self'; style-src 'unsafe-inline'; form-action *; base-uri 'self'";

const rateBuckets = new Map();
function rateLimit(key, max = 60, windowMs = 60_000) {
  const t = Date.now();
  let b = rateBuckets.get(key);
  if (!b || t - b.start > windowMs) {
    b = { start: t, count: 0 };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    throw makeError('RATE_LIMITED', 'Rate limited');
  }
}

function log(entry) {
  const o = { ts: new Date().toISOString(), ...entry };
  delete o.token;
  delete o.password;
  delete o.authorization;
  console.error(JSON.stringify(o));
}

function send(res, code, body, reqId, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Request-Id': reqId || '',
    ...extraHeaders,
  };
  if (CORS_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = CORS_ORIGIN;
    headers['Access-Control-Allow-Headers'] =
      'Authorization, Content-Type, X-Request-Id, Mcp-Session-Id';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS, DELETE';
  }
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  if (typeof body === 'string') {
    headers['Content-Type'] = extraHeaders['Content-Type'] || 'text/html; charset=utf-8';
  }
  res.writeHead(code, headers);
  res.end(data);
}

function sendHtml(res, code, html, reqId, extraHeaders = {}) {
  return send(res, code, html, reqId, {
    'Content-Type': 'text/html; charset=utf-8',
    ...extraHeaders,
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) {
        reject(makeError('VALIDATION_ERROR', 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of params) obj[k] = v;
        return resolve(obj);
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(makeError('VALIDATION_ERROR', 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

async function toolContextFromAuth(identity) {
  let accessToken = identity.supabaseAccessToken || null;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {},
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const user = { id: identity.userId, email: identity.email };
  const baseEnt = await getUserEntitlement(user.id);
  const oauthScopes = new Set(identity.scope || []);
  const scopes = {};
  for (const s of Object.keys(baseEnt.scopes || {})) {
    scopes[s] = !!baseEnt.scopes[s] && (oauthScopes.size === 0 || oauthScopes.has(s));
  }
  return { sb, user, entitlement: { ...baseEnt, scopes } };
}

const DESTRUCTIVE_TOOLS = new Set(['delete_library_item', 'delete_folder']);
const TOOL_DEFS = Object.entries(TOOL_SCOPES).map(([name, scope]) => ({
  name,
  description: `Roy library tool (${scope})`,
  inputSchema: { type: 'object', additionalProperties: true },
  annotations: DESTRUCTIVE_TOOLS.has(name)
    ? { destructiveHint: true, readOnlyHint: false }
    : { readOnlyHint: scope === 'library:read' },
}));

async function handleMcpJsonRpc(msg, ctx, reqId) {
  const method = msg.method;
  const id = msg.id ?? null;
  const params = msg.params || {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'roys-prompt-library', version: '3.9.1' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return null;
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } };
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    try {
      rateLimit(`tool:${ctx.user.id}:${name}`, name === 'delete_library_item' ? 15 : 60);
      const result = await runTool(name, args, ctx);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ code: err.code || 'INTERNAL_ERROR', message: err.message }),
            },
          ],
          isError: true,
        },
      };
    }
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function protectedResourceMetadata() {
  return {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    scopes_supported: [
      'library:read',
      'library:write',
      'library:delete',
      'library:share',
      'openid',
      'offline_access',
    ],
    bearer_methods_supported: ['header'],
  };
}

function unauthorized(res, reqId, message = 'Unauthorized') {
  return send(res, 401, { code: 'UNAUTHORIZED', message }, reqId, {
    'WWW-Authenticate': `Bearer realm="Roy's Digital Library MCP", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
  });
}

const server = http.createServer(async (req, res) => {
  const reqId = req.headers['x-request-id'] || randomUUID();
  const start = Date.now();
  const url = new URL(req.url || '/', PUBLIC_URL);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', reqId);
  }

  try {
    // Landing
    if (req.method === 'GET' && url.pathname === '/') {
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roy's Digital Library MCP</title>
<style>
body{font-family:Inter,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:48px 24px;background:#faf5ea;color:#1e2436}
.card{background:#fffdf8;border:1px solid #e7dcc4;border-radius:18px;padding:28px;box-shadow:0 8px 30px rgba(30,36,54,.08)}
h1{margin:0 0 8px}p{line-height:1.6;color:#5b574c}code{background:#f1eadb;padding:3px 7px;border-radius:6px}
.ok{font-weight:700}.links{display:grid;gap:10px;margin-top:20px}
a{color:#806814;text-decoration:none}a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
<h1>Roy's Digital Library MCP</h1>
<p>Hosted Model Context Protocol server for Roy's Digital Library.</p>
<p class="ok">✓ Hosted endpoint is configured</p>
<p>MCP endpoint: <code>${PUBLIC_URL}/mcp</code></p>
<div class="links">
<a href="/health">Health check</a>
<a href="/ready">Readiness check</a>
<a href="/.well-known/oauth-authorization-server">OAuth discovery</a>
<a href="/.well-known/oauth-protected-resource">Protected resource metadata</a>
</div>
</div>
</body>
</html>`;
      return sendHtml(res, 200, html, reqId);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { status: 'ok', service: 'roys-mcp', version: '3.9.1' }, reqId);
    }

    if (req.method === 'GET' && url.pathname === '/ready') {
      const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
      return send(
        res,
        configured ? 200 : 503,
        {
          ready: configured,
          supabase_configured: configured,
          oauth: true,
          mcp_streamable_http: true,
          public_url: PUBLIC_URL,
        },
        reqId
      );
    }

    if (
      req.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp')
    ) {
      return send(res, 200, protectedResourceMetadata(), reqId, {
        'Access-Control-Allow-Origin': '*',
      });
    }

    if (
      req.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/.well-known/openid-configuration')
    ) {
      return send(res, 200, oauthMetadata(PUBLIC_URL), reqId);
    }

    // OAuth authorize GET
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') || '';
      if (!validateRedirectUri(redirectUri, OAUTH_REDIRECT_ALLOWLIST)) {
        return send(res, 400, { error: 'invalid_request', error_description: 'redirect_uri not allowed' }, reqId);
      }
      if (q.get('response_type') !== 'code') {
        return send(res, 400, { error: 'unsupported_response_type' }, reqId);
      }
      if ((q.get('code_challenge_method') || 'S256') !== 'S256') {
        return send(res, 400, { error: 'invalid_request', error_description: 'S256 required' }, reqId);
      }
      const html = authorizePageHtml({
        clientId: q.get('client_id') || 'roys-mcp',
        redirectUri,
        state: q.get('state'),
        scope: q.get('scope'),
        codeChallenge: q.get('code_challenge'),
      });
      return sendHtml(res, 200, html, reqId, {
        'Content-Security-Policy': OAUTH_HTML_CSP,
      });
    }

    // OAuth authorize POST
    if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
      rateLimit(`oauth-auth:${req.socket.remoteAddress}`, 20);
      const body = await readBody(req);
      if (!validateRedirectUri(body.redirect_uri, OAUTH_REDIRECT_ALLOWLIST)) {
        return send(res, 400, { error: 'invalid_request', error_description: 'redirect_uri not allowed' }, reqId);
      }
      try {
        const user = await loginWithPassword(SUPABASE_URL, SUPABASE_ANON_KEY, body.email, body.password);
        const code = issueAuthorizationCode({
          clientId: body.client_id || 'roys-mcp',
          redirectUri: body.redirect_uri,
          codeChallenge: body.code_challenge,
          codeChallengeMethod: body.code_challenge_method || 'S256',
          scope: body.scope,
          state: body.state,
          userId: user.userId,
          email: user.email,
          supabaseAccessToken: user.accessToken,
          supabaseRefreshToken: user.refreshToken,
        });
        const redirect = new URL(body.redirect_uri);
        redirect.searchParams.set('code', code);
        if (body.state) redirect.searchParams.set('state', body.state);
        res.writeHead(302, {
          Location: redirect.toString(),
          'Cache-Control': 'no-store',
          'X-Request-Id': reqId,
        });
        res.end();
        log({ reqId, event: 'oauth_authorize_ok', user: user.userId.slice(0, 8), ms: Date.now() - start });
        return;
      } catch (err) {
        const html = authorizePageHtml({
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          state: body.state,
          scope: body.scope,
          codeChallenge: body.code_challenge,
          error: err.message || 'Login failed',
        });
        return sendHtml(res, 401, html, reqId, {
          'Content-Security-Policy': OAUTH_HTML_CSP,
        });
      }
    }

    // OAuth token
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      rateLimit(`oauth-token:${req.socket.remoteAddress}`, 30);
      const body = await readBody(req);
      try {
        if (body.grant_type === 'authorization_code') {
          const tok = exchangeAuthorizationCode({
            code: body.code,
            redirectUri: body.redirect_uri,
            codeVerifier: body.code_verifier,
            clientId: body.client_id,
          });
          log({ reqId, event: 'token_issued', ms: Date.now() - start });
          return send(res, 200, tok, reqId);
        }
        if (body.grant_type === 'refresh_token') {
          const tok = refreshAccessToken({
            refreshToken: body.refresh_token,
            clientId: body.client_id,
          });
          return send(res, 200, tok, reqId);
        }
        return send(res, 400, { error: 'unsupported_grant_type' }, reqId);
      } catch (err) {
        return send(
          res,
          400,
          { error: err.code || 'invalid_grant', error_description: err.message },
          reqId
        );
      }
    }

    // OAuth revoke
    if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
      rateLimit(`oauth-revoke:${req.socket.remoteAddress}`, 30);
      const body = await readBody(req);
      const result = revokeToken(body.token);
      log({ reqId, event: 'oauth_revoke', actually_revoked: result.revoked, ms: Date.now() - start });
      return send(res, 200, { revoked: true }, reqId);
    }

    // MCP Streamable HTTP
    if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/mcp/rpc')) {
      const token = bearer(req);
      let identity;
      try {
        identity = await resolveOAuthBearer(token, {
          supabaseUrl: SUPABASE_URL,
          supabaseAnonKey: SUPABASE_ANON_KEY,
        });
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') return unauthorized(res, reqId, err.message);
        throw err;
      }
      rateLimit(`mcp:${identity.userId}`, 120);
      const ctx = await toolContextFromAuth(identity);
      const body = await readBody(req);

      if (Array.isArray(body)) {
        const out = [];
        for (const msg of body) {
          const r = await handleMcpJsonRpc(msg, ctx, reqId);
          if (r) out.push(r);
        }
        log({
          reqId,
          event: 'mcp_batch',
          n: body.length,
          user: identity.userId.slice(0, 8),
          ms: Date.now() - start,
        });
        return send(res, 200, out, reqId);
      }

      const r = await handleMcpJsonRpc(body, ctx, reqId);
      if (r === null) return send(res, 202, {}, reqId);
      log({
        reqId,
        event: 'mcp',
        method: body.method,
        user: identity.userId.slice(0, 8),
        ms: Date.now() - start,
      });
      return send(res, 200, r, reqId);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/mcp/tools/')) {
      const name = decodeURIComponent(url.pathname.slice('/mcp/tools/'.length));
      const token = bearer(req);
      let identity;
      try {
        identity = await resolveOAuthBearer(token, {
          supabaseUrl: SUPABASE_URL,
          supabaseAnonKey: SUPABASE_ANON_KEY,
        });
      } catch (err) {
        if (err.code === 'UNAUTHORIZED') return unauthorized(res, reqId, err.message);
        throw err;
      }
      const ctx = await toolContextFromAuth(identity);
      const args = await readBody(req);
      const result = await runTool(name, args, ctx);
      return send(res, 200, { ok: true, result }, reqId);
    }

    if (req.method === 'GET' && url.pathname === '/mcp/tools') {
      return send(res, 200, { tools: TOOL_DEFS }, reqId);
    }

    send(res, 404, { code: 'NOT_FOUND', message: 'Not found' }, reqId);
  } catch (err) {
    const code = err.code || 'INTERNAL_ERROR';
    const status =
      code === 'UNAUTHORIZED' || code === 'access_denied'
        ? 401
        : code === 'FORBIDDEN'
          ? 403
          : code === 'VALIDATION_ERROR' || code === 'invalid_request'
            ? 400
            : code === 'RATE_LIMITED'
              ? 429
              : code === 'NOT_FOUND'
                ? 404
                : 500;
    log({ reqId, status, code, message: err.message, ms: Date.now() - start });
    send(res, status, { code, message: err.message || 'Error' }, reqId);
  }
});

server.listen(PORT, () => {
  log({ event: 'listen', port: PORT, public_url: PUBLIC_URL });
});