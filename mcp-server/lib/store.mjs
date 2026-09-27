/**
 * Persistent key-value store for MCP OAuth state.
 *
 * Why this exists:
 *   The original implementation kept authorization codes, access tokens and
 *   refresh tokens in plain `Map`s. That meant every server restart logged
 *   every connected client out, and it could never run as more than one
 *   process. This module swaps that for a file-backed store with atomic
 *   writes, so state survives restarts on a single-instance deployment.
 *
 * Encryption at rest (v3.9 security fix):
 *   This bucket holds live Supabase access/refresh tokens (see oauth.mjs),
 *   which are bearer credentials for the user's whole account. Everything
 *   written to disk is now sealed with AES-256-GCM under a key supplied via
 *   the MCP_OAUTH_STORE_KEY environment variable — never hard-coded, never
 *   logged, never committed. If that variable isn't set, this module
 *   refuses to write anything to disk at all (state stays in-memory only
 *   and does not survive a restart) rather than ever falling back to
 *   plaintext. A pre-existing plaintext store from before this fix is
 *   detected on load and, once a key is configured, transparently migrated
 *   to the encrypted format and the plaintext copy is overwritten; see
 *   migrateLegacyPlaintextStore() below for the one-shot CLI version of
 *   the same migration.
 *
 * Scaling beyond one instance:
 *   This is still not safe for multiple concurrent server processes (no
 *   locking, last-writer-wins on flush). If you deploy more than one
 *   instance behind a load balancer, replace this module with a Redis or
 *   Postgres-backed implementation that exposes the same get/set/delete/gc
 *   interface — nothing outside this file needs to change.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_PATH =
  process.env.MCP_OAUTH_STORE_PATH || path.join(process.cwd(), 'data', 'oauth-store.json');

const KEY_ENV_VAR = 'MCP_OAUTH_STORE_KEY';
const ENC_ALG = 'aes-256-gcm';

/**
 * Load the at-rest encryption key from the environment. Accepts either a
 * 64-char hex string or a base64 string that decodes to exactly 32 bytes
 * (256 bits) — e.g. the output of `openssl rand -base64 32` or
 * `openssl rand -hex 32`. Never accepts a key embedded in source.
 */
function loadEncryptionKey(envValue = process.env[KEY_ENV_VAR]) {
  if (!envValue) return null;
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(envValue)) {
    buf = Buffer.from(envValue, 'hex');
  } else {
    try {
      buf = Buffer.from(envValue, 'base64');
    } catch {
      buf = Buffer.alloc(0);
    }
  }
  if (buf.length !== 32) {
    throw new Error(
      `${KEY_ENV_VAR} must decode to exactly 32 bytes (got ${buf.length}). ` +
      'Generate one with: openssl rand -base64 32'
    );
  }
  return buf;
}

function encryptState(key, stateObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(stateObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ENC_ALG,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

function decryptState(key, envelope) {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const decipher = crypto.createDecipheriv(ENC_ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function isEncryptedEnvelope(parsed) {
  return !!(parsed && parsed.v === 1 && parsed.alg === ENC_ALG && parsed.iv && parsed.tag && parsed.data);
}

function emptyState() {
  return {
    codes: {},
    tokens: {},
    refreshTokens: {},
    // Refresh tokens that have already been redeemed once. Kept around
    // (briefly) so a second redemption of the same token can be recognized
    // as theft/replay rather than just failing silently.
    usedRefreshTokens: {},
  };
}

class Store {
  constructor(filePath = DEFAULT_PATH, encryptionKey = undefined) {
    this.filePath = filePath;
    this.state = emptyState();
    this._dirty = false;
    this._flushTimer = null;
    this._warnedNoKey = false;
    // encryptionKey === undefined means "read from env"; pass null/Buffer
    // explicitly in tests to override without touching process.env.
    this.key = encryptionKey === undefined ? loadEncryptionKey() : encryptionKey;
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw) return;
      const parsed = JSON.parse(raw);

      if (isEncryptedEnvelope(parsed)) {
        if (!this.key) {
          // We cannot read this without the key. Do NOT overwrite it —
          // just start with empty in-memory state until the operator
          // configures MCP_OAUTH_STORE_KEY, at which point a restart will
          // decrypt it correctly. This never falls back to plaintext.
          console.error(
            `[oauth-store] Store is encrypted but ${KEY_ENV_VAR} is not set — ` +
            'starting with empty in-memory session state. Set the key to the ' +
            'value used when this store was written to decrypt existing sessions.'
          );
          this.state = emptyState();
          return;
        }
        this.state = { ...emptyState(), ...decryptState(this.key, parsed) };
        return;
      }

      // Legacy plaintext store from before encryption-at-rest existed.
      // Load it so in-flight sessions aren't dropped, then — if a key is
      // available — immediately re-write it encrypted, replacing the
      // plaintext file on disk (this IS the migration; no separate script
      // to remember to run).
      this.state = { ...emptyState(), ...parsed };
      if (this.key) {
        console.error('[oauth-store] Migrating legacy plaintext oauth-store.json to encrypted storage.');
        this._dirty = true;
        this._flush();
      } else {
        console.error(
          `[oauth-store] Found a legacy plaintext oauth-store.json and ${KEY_ENV_VAR} is not set. ` +
          'Refusing to write further plaintext secrets to disk: sessions will work for this process ' +
          'but will not be persisted until a key is configured (existing plaintext file left as-is).'
        );
      }
    } catch (err) {
      // A corrupt or unreadable store file should not crash the server —
      // start clean and let clients re-authenticate.
      console.error('[oauth-store] load failed, starting empty:', err.message);
      this.state = emptyState();
    }
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this._flush(), 200);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  _flush() {
    this._flushTimer = null;
    if (!this._dirty) return;
    this._dirty = false;
    if (!this.key) {
      // Never write access/refresh tokens to disk in plaintext. Sessions
      // simply won't survive a restart until MCP_OAUTH_STORE_KEY is set.
      if (!this._warnedNoKey) {
        console.error(
          `[oauth-store] ${KEY_ENV_VAR} is not set — OAuth sessions are in-memory only ` +
          'and will be lost on restart. Set it to persist sessions safely (encrypted).'
        );
        this._warnedNoKey = true;
      }
      return;
    }
    const envelope = encryptState(this.key, this.state);
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath); // atomic on same filesystem
      try { fs.chmodSync(this.filePath, 0o600); } catch { /* best-effort on platforms without chmod */ }
    } catch (err) {
      console.error('[oauth-store] flush failed:', err.message);
    }
  }

  /** Force an immediate write (e.g. on graceful shutdown). */
  flushSync() {
    this._flush();
  }

  get(bucket, key) {
    return this.state[bucket]?.[key];
  }

  set(bucket, key, value) {
    if (!this.state[bucket]) this.state[bucket] = {};
    this.state[bucket][key] = value;
    this._scheduleFlush();
  }

  delete(bucket, key) {
    if (this.state[bucket] && key in this.state[bucket]) {
      delete this.state[bucket][key];
      this._scheduleFlush();
    }
  }

  has(bucket, key) {
    return !!(this.state[bucket] && key in this.state[bucket]);
  }

  entries(bucket) {
    return Object.entries(this.state[bucket] || {});
  }

  /** Delete every record in every bucket whose familyId matches. */
  revokeFamily(familyId) {
    let changed = false;
    for (const bucket of ['tokens', 'refreshTokens']) {
      for (const [k, v] of this.entries(bucket)) {
        if (v && v.familyId === familyId) {
          delete this.state[bucket][k];
          changed = true;
        }
      }
    }
    if (changed) this._scheduleFlush();
  }

  /** Drop expired codes/tokens. Cheap enough to call on every request. */
  gc(now = Date.now()) {
    let changed = false;
    for (const bucket of ['codes', 'tokens', 'refreshTokens', 'usedRefreshTokens']) {
      for (const [k, v] of this.entries(bucket)) {
        if (v && v.expiresAt && v.expiresAt < now) {
          delete this.state[bucket][k];
          changed = true;
        }
      }
    }
    if (changed) this._scheduleFlush();
  }
}

let singleton = null;

/** Get the process-wide store instance (creates it on first call). */
export function getStore(filePath) {
  if (!singleton) singleton = new Store(filePath);
  return singleton;
}

/**
 * Testing helper: force a fresh store bound to a specific file (and,
 * optionally, an explicit key instead of reading MCP_OAUTH_STORE_KEY from
 * the environment).
 */
export function resetStoreForTests(filePath, encryptionKey) {
  singleton = new Store(filePath, encryptionKey);
  return singleton;
}

/**
 * One-shot CLI migration: `node -e "import('./lib/store.mjs').then(m=>m.migrateLegacyPlaintextStore())"`
 * or wire it into a package.json script. Loads whatever is at
 * MCP_OAUTH_STORE_PATH (or the default path), and if it's legacy plaintext
 * and MCP_OAUTH_STORE_KEY is set, rewrites it encrypted in place. Never
 * prints token contents — only counts and file paths.
 */
export function migrateLegacyPlaintextStore(filePath = DEFAULT_PATH) {
  const key = loadEncryptionKey();
  if (!key) {
    throw new Error(`Set ${KEY_ENV_VAR} before running the migration (openssl rand -base64 32).`);
  }
  if (!fs.existsSync(filePath)) {
    return { migrated: false, reason: 'no store file found', filePath };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = raw ? JSON.parse(raw) : {};
  if (isEncryptedEnvelope(parsed)) {
    return { migrated: false, reason: 'already encrypted', filePath };
  }
  const state = { ...emptyState(), ...parsed };
  const counts = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, Object.keys(v || {}).length]));
  const envelope = encryptState(key, state);
  const tmp = `${filePath}.tmp-migrate-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  return { migrated: true, filePath, counts };
}
