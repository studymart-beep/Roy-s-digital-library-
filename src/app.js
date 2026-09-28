/**
 * Roy's Digital Library — Main Application
 * Cloud-synced PWA with offline support
 */

import {
  openDB, seedIfEmpty, getAllFolders, getFolder, saveFolder, softDeleteFolderCascade,
  getAllPrompts, getPrompt, getFavorites, savePrompt, deletePrompt, restorePrompt, getDeletedPrompts,
  getImagesByParent, saveImage, exportAll, importAll, getMeta, setMeta, clearLocalUserData,
  getAllLibraryItems, getLibraryItem, saveLibraryItem, deleteLibraryItem, getLibraryItemsByFolder,
  getLinksForItem, saveItemLink, deleteItemLink, getAllItemLinks
} from './db.js';

import { getSupabase, CLOUD_ENABLED } from './supabase.js';
import {
  fullSync, startRealtime, stopRealtime, initNetworkListeners,
  getSyncStatus, onSyncStatusChange, migrateLocalToCloud, cloudHasData,
  uploadImageToStorage
} from './sync.js';

import {
  createShareLink, listSharesForPrompt, listAllShares, revokeShare, shareUrlForToken
} from './share.js';

// ── State ─────────────────────────────────────────────────────
const state = {
  view: 'home',
  currentFolderId: 'root',
  path: [],
  theme: localStorage.getItem('theme') || 'light',
  user: null,           // { id, email }
  authReady: false,
  showAuth: false,
};

// ── Utils ─────────────────────────────────────────────────────
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

function toast(msg, duration = 1800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), duration);
}

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return [...document.querySelectorAll(sel)]; }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('✓ Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('✓ Copied');
  }
}

function applyTheme() {
  document.body.classList.toggle('light', state.theme === 'light');
  document.body.classList.toggle('dark', state.theme === 'dark');
  localStorage.setItem('theme', state.theme);
  const sun = $('.icon-sun');
  const moon = $('.icon-moon');
  if (state.theme === 'light') {
    sun?.classList.add('hidden');
    moon?.classList.remove('hidden');
  } else {
    sun?.classList.remove('hidden');
    moon?.classList.add('hidden');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeSourceUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}


const ITEM_TYPES = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'research', label: 'Research' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'idea', label: 'Idea' },
  { id: 'note', label: 'Note' },
  { id: 'resource', label: 'Resource' },
  { id: 'template', label: 'Template' },
  { id: 'experiment', label: 'Experiment' },
  { id: 'product_asset', label: 'Product Asset' },
];

function itemTypeLabel(type) {
  return (ITEM_TYPES.find(t => t.id === type) || { label: type || 'Item' }).label;
}

function folderIcon() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
}

// ── Auth ──────────────────────────────────────────────────────
// Guard: onSignedIn must run exactly once per session activation
let signedInBootstrapDone = false;

async function initAuth() {
  if (!CLOUD_ENABLED) {
    state.authReady = true;
    state.showAuth = false;
    return;
  }
  const supabase = getSupabase();

  // 1. Restore existing session immediately
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    state.user = { id: session.user.id, email: session.user.email };
    state.showAuth = false;
  } else {
    state.showAuth = true;
  }
  state.authReady = true;

  // 2. Listen for future auth changes (sign-in, sign-out, token refresh).
  //    Skip INITIAL_SESSION — bootstrap is driven by getSession() below (and by
  //    explicit SIGNED_IN), so we never depend on a later auth event for startup.
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'INITIAL_SESSION') return;

    if (event === 'SIGNED_IN' && session?.user) {
      state.user = { id: session.user.id, email: session.user.email };
      state.showAuth = false;
      signedInBootstrapDone = false; // fresh sign-in may bootstrap again
      await onSignedIn();
    } else if (event === 'TOKEN_REFRESHED' && session?.user) {
      // Keep identity in sync; do not re-run full bootstrap
      state.user = { id: session.user.id, email: session.user.email };
      state.showAuth = false;
    } else if (event === 'USER_UPDATED' && session?.user) {
      state.user = { id: session.user.id, email: session.user.email };
    } else if (event === 'SIGNED_OUT') {
      state.user = null;
      state.showAuth = true;
      signedInBootstrapDone = false;
      stopRealtime();
      state.currentFolderId = 'root';
      state.path = [];
      state.view = 'home';
      try { await clearLocalUserData(); } catch (_) {}
      render();
    }
  });

  // Periodic session health check (expired JWT → force re-auth UX)
  setInterval(async () => {
    if (!CLOUD_ENABLED || !state.user) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        state.user = null;
        state.showAuth = true;
        signedInBootstrapDone = false;
        stopRealtime();
        toast('Session expired — please sign in again');
        render();
      }
    } catch (_) {}
  }, 5 * 60 * 1000);

  // 3. CRITICAL: existing session must bootstrap sync NOW — do not wait for an event.
  //    onSignedIn is idempotent via signedInBootstrapDone.
  if (state.user) {
    await onSignedIn();
  }
}

/**
 * Complete sync startup for an authenticated user.
 * Safe to call on app reload and on fresh sign-in.
 * Idempotent within a single page session via signedInBootstrapDone.
 */
async function onSignedIn() {
  if (!state.user) return;
  if (signedInBootstrapDone) return;
  signedInBootstrapDone = true;

  try {
    const migrated = await getMeta('migratedToCloud');
    const localFolders = await getAllFolders();
    const localPrompts = await getAllPrompts();
    // Images alone must also count as local library data
    let localImageCount = 0;
    try {
      const { getAllImagesRaw } = await import('./db.js');
      const imgs = await getAllImagesRaw();
      localImageCount = (imgs || []).filter(i => !i.deletedAt).length;
    } catch (_) {}
    const hasLocal =
      localFolders.length > 1 ||
      localPrompts.length > 0 ||
      localImageCount > 0;
    const hasCloud = await cloudHasData(state.user.id);

    if (hasLocal && !migrated && !hasCloud) {
      offerMigration();
      return;
    }

    // Startup order (closes race between pull and Realtime subscribe):
    // 1) Subscribe to Realtime first so changes during bootstrap are buffered
    // 2) Push pending + pull/merge
    // 3) Final catch-up pull so nothing between step 1–2 is missed
    // 4) Network listeners + render
    startRealtime(state.user.id, () => render());
    await fullSync(state.user.id, { catchUp: true });
    // After account switch, local may be empty until pull — ensure root exists for empty accounts
    await seedIfEmpty();
    initNetworkListeners(state.user.id, () => render());
    render();
  } catch (err) {
    console.error('[auth] onSignedIn failed', err);
    signedInBootstrapDone = false; // allow retry
    toast('Sync startup issue — will retry');
    render();
  }
}

function offerMigration() {
  openModal(`
    <div class="modal-title">Import local library?</div>
    <p style="color:var(--text-secondary);margin-bottom:16px;font-size:15px;line-height:1.5;">
      We found prompts and folders already saved on this device.
      Would you like to upload them to your cloud account so they appear on all your devices?
    </p>
    <div id="migration-progress" class="hidden" style="margin-bottom:16px;font-size:14px;color:var(--text-secondary);line-height:1.6;"></div>
    <div class="btn-row" id="migration-actions">
      <button class="btn btn-secondary" id="start-empty">Start Empty</button>
      <button class="btn btn-primary" id="import-cloud">Import to Cloud</button>
    </div>
  `);

  const finishBootstrap = async () => {
    startRealtime(state.user.id, () => render());
    await fullSync(state.user.id, { catchUp: true });
    initNetworkListeners(state.user.id, () => render());
    render();
  };

  $('#start-empty').addEventListener('click', async () => {
    await setMeta('migratedToCloud', true);
    closeModal();
    await finishBootstrap();
  });

  $('#import-cloud').addEventListener('click', async () => {
    const progressEl = $('#migration-progress');
    const actionsEl = $('#migration-actions');
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = 'Migrating your library…';
    actionsEl.classList.add('hidden');

    try {
      await migrateLocalToCloud(state.user.id, ({ phase, current, total }) => {
        progressEl.innerHTML = `
          <strong>Migrating your library…</strong><br>
          Folders / Prompts / Images in progress<br>
          <span style="color:var(--accent)">${escapeHtml(phase)}: ${current}/${total}</span>
        `;
      });
      progressEl.innerHTML = '<strong style="color:var(--success)">Migration complete ✓</strong>';
      toast('Library uploaded to cloud');
      setTimeout(async () => {
        closeModal();
        await finishBootstrap();
      }, 800);
    } catch (e) {
      progressEl.innerHTML = `<span style="color:var(--danger)">Upload failed: ${escapeHtml(e.message || 'error')}</span>`;
      actionsEl.classList.remove('hidden');
      signedInBootstrapDone = false;
    }
  });
}

function friendlyAuthError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials')) return 'Wrong email or password.';
  if (m.includes('email not confirmed')) return 'Confirm your email first (check inbox).';
  if (m.includes('user already registered')) return 'Account already exists — sign in instead.';
  if (m.includes('password')) return 'Password must be at least 6 characters.';
  if (m.includes('rate') || m.includes('too many')) return 'Too many attempts — wait a minute.';
  if (m.includes('network') || m.includes('fetch')) return 'Network error — check your connection.';
  return err?.message || 'Authentication failed.';
}

async function signIn(email, password) {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyAuthError(error));
}

async function signUp(email, password) {
  const supabase = getSupabase();
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(friendlyAuthError(error));
}

async function resetPassword(email) {
  const supabase = getSupabase();
  if (!email) throw new Error('Enter your email first.');
  const redirectTo = typeof location !== 'undefined' ? location.origin + '/' : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined);
  if (error) throw new Error(friendlyAuthError(error));
}

async function signInWithGoogle() {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

async function signOut() {
  const supabase = getSupabase();
  try {
    await supabase.auth.signOut();
  } catch (e) {
    console.warn('signOut', e);
  }
  stopRealtime();
  state.user = null;
  state.showAuth = true;
  state.currentFolderId = 'root';
  state.path = [];
  state.view = 'home';
  try {
    await clearLocalUserData();
  } catch (e) {
    console.warn('clearLocalUserData', e);
  }
  signedInBootstrapDone = false;
  toast('Signed out — local cache cleared');
  render();
}

// ── Navigation ────────────────────────────────────────────────
async function navigateToFolder(folderId) {
  state.currentFolderId = folderId;
  state.view = 'folder';
  await buildPath(folderId);
  render();
}

async function buildPath(folderId) {
  const path = [];
  let id = folderId;
  while (id) {
    const f = await getFolder(id);
    if (!f) break;
    path.unshift(f);
    id = f.parentId;
  }
  state.path = path;
}

function goBack() {
  if (state.path.length > 1) {
    const parent = state.path[state.path.length - 2];
    navigateToFolder(parent.id);
  } else {
    state.view = 'home';
    state.currentFolderId = 'root';
    state.path = [];
    render();
  }
}

// ── Topbar + Sync indicator ───────────────────────────────────
function updateTopbar() {
  const back = $('#btn-back');
  const crumb = $('#breadcrumb');
  const syncEl = $('#sync-indicator');

  const brand = document.getElementById('brand-mark');
  if (state.view === 'home' || state.view === 'favorites' || state.view === 'tags' || state.view === 'settings') {
    back.classList.add('hidden');
    if (brand) brand.classList.remove('hidden');
    const titles = { home: 'Library', favorites: 'Favorites', tags: 'Tags', settings: 'Settings' };
    crumb.innerHTML = `<span class="crumb active">${titles[state.view] || 'Library'}</span>`;
  } else {
    back.classList.remove('hidden');
    if (brand) brand.classList.add('hidden');
    crumb.innerHTML = state.path.map((f, i) => {
      const isLast = i === state.path.length - 1;
      return `<span class="crumb ${isLast ? 'active' : ''}" data-id="${f.id}">${escapeHtml(f.name)}</span>${isLast ? '' : '<span class="crumb-sep">/</span>'}`;
    }).join('');
    $all('.crumb[data-id]').forEach(el => {
      if (!el.classList.contains('active')) {
        el.addEventListener('click', () => navigateToFolder(el.dataset.id));
      }
    });
  }

  // Sync status
  if (syncEl) {
    const { status, error, pending } = getSyncStatus();
    const map = {
      synced: { text: '✓ Synced', cls: 'sync-ok' },
      syncing: { text: pending > 0 ? `↻ Syncing… ${pending}` : '↻ Syncing…', cls: 'sync-busy' },
      offline: { text: pending > 0 ? `⚠ Offline · ${pending}` : '⚠ Offline', cls: 'sync-warn' },
      error: { text: '! Sync error', cls: 'sync-err' },
      unknown: { text: '', cls: '' },
    };
    // Never show Synced if pending ops remain
    let effective = status;
    if (status === 'synced' && pending > 0) effective = 'syncing';
    const s = map[effective] || map.unknown;
    syncEl.textContent = s.text;
    syncEl.className = 'sync-indicator ' + s.cls;
    syncEl.title = error || s.text;
  }
}

// ── Auth Screen ───────────────────────────────────────────────
function renderAuth() {
  const main = $('#main');
  main.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <img class="auth-logo" src="logo.png" alt="Roy's Digital Library" />
        <h1>Roy's Digital Library</h1>
        <p class="auth-sub">Your personal AI command center.</p>

        <div class="form-group">
          <label>Email</label>
          <input type="email" id="auth-email" placeholder="you@email.com" autocomplete="email" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="auth-password" placeholder="••••••••" autocomplete="current-password" />
        </div>
        <div id="auth-error" class="auth-error hidden"></div>
        <div class="btn-row" style="margin-top:8px;">
          <button class="btn btn-primary" id="btn-signin" style="flex:1;">Sign In</button>
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-signup" style="flex:1;">Create Account</button>
        </div>
        <div class="auth-divider"><span>or</span></div>
        <button class="btn btn-secondary" id="btn-google" style="width:100%;">
          Continue with Google
        </button>
        ${!CLOUD_ENABLED ? `
          <p style="margin-top:20px;font-size:13px;color:var(--warning);text-align:center;line-height:1.4;">
            Cloud is not configured yet.<br>
            Edit <code>src/config.js</code> with your Supabase keys,<br>
            then refresh. You can still use the app offline.
          </p>
          <button class="btn btn-secondary" id="btn-skip-auth" style="width:100%;margin-top:12px;">
            Continue Offline
          </button>
        ` : ''}
      </div>
    </div>
  `;

  const showErr = (msg) => {
    const el = $('#auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  };

  $('#btn-signin')?.addEventListener('click', async () => {
    try {
      await signIn($('#auth-email').value.trim(), $('#auth-password').value);
    } catch (e) {
      showErr(e.message || 'Sign in failed');
    }
  });
  $('#btn-signup')?.addEventListener('click', async () => {
    try {
      await signUp($('#auth-email').value.trim(), $('#auth-password').value);
      toast('Check your email to confirm, then sign in');
    } catch (e) {
      showErr(e.message || 'Sign up failed');
    }
  });
  $('#btn-google')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      showErr(e.message || 'Google sign-in failed');
    }
  });
  $('#btn-skip-auth')?.addEventListener('click', () => {
    state.showAuth = false;
    render();
  });
}

// ── Views (preserved from original) ───────────────────────────
async function renderHome() {
  const folders = await getAllFolders();
  const prompts = await getAllPrompts();
  const libItems = await getAllLibraryItems();
  const rootFolders = folders.filter(f => f.parentId === 'root');
  const recent = [...prompts, ...libItems]
    .sort((a, b) => (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0))
    .slice(0, 8);
  const favs = [...prompts.filter(p => p.isFavorite), ...libItems.filter(i => i.isFavorite)].slice(0, 4);

  const main = $('#main');
  main.innerHTML = `
    <div class="desktop-layout">
      <aside class="desktop-sidebar" id="desktop-sidebar">
        <div class="sidebar-title">Folders</div>
        ${rootFolders.map(f => `
          <button class="sidebar-folder" data-folder-id="${f.id}">
            ${folderIcon()} <span>${escapeHtml(f.name)}</span>
          </button>
        `).join('') || '<p class="sidebar-empty">No folders yet</p>'}
      </aside>
      <div class="desktop-main">
        <div class="hero">
          <h1>Roy's Digital Library</h1>
          <p>Your prompts. Everywhere.</p>
        </div>
        <div class="quick-stats">
          <div class="stat-card"><div class="stat-value">${prompts.length + libItems.length}</div><div class="stat-label">Items</div></div>
          <div class="stat-card"><div class="stat-value">${folders.filter(f => f.id !== 'root').length}</div><div class="stat-label">Folders</div></div>
          <div class="stat-card"><div class="stat-value">${favs.length}</div><div class="stat-label">Favorites</div></div>
        </div>
        <div class="section-title">Folders</div>
        ${rootFolders.length === 0 ? '<div class="empty-state"><p>Your library is empty. Tap the gold <strong>+</strong> button at the bottom to add a folder or prompt.</p></div>' : ''}
        ${rootFolders.map(f => renderFolderCard(f, folders, prompts)).join('')}
        ${favs.length ? `<div class="section-title">Favorites</div><div class="prompts-grid">${favs.map(p => p.itemType ? renderLibraryCard(p) : renderPromptCard(p)).join('')}</div>` : ''}
        ${recent.length ? `<div class="section-title">Recent activity</div><div class="prompts-grid">${recent.map(p => p.itemType ? renderLibraryCard(p) : renderPromptCard(p)).join('')}</div>` : ''}
      </div>
    </div>
  `;
  bindFolderCards();
  bindPromptCards();
  bindLibraryCards();
  $all('.sidebar-folder').forEach(el => el.addEventListener('click', () => navigateToFolder(el.dataset.folderId)));
}

function renderFolderCard(folder, allFolders, allPrompts) {
  const childCount = allFolders.filter(f => f.parentId === folder.id).length;
  const promptCount = allPrompts.filter(p => p.folderId === folder.id).length;
  const meta = [];
  if (childCount) meta.push(`${childCount} folder${childCount > 1 ? 's' : ''}`);
  if (promptCount) meta.push(`${promptCount} prompt${promptCount > 1 ? 's' : ''}`);
  return `
    <div class="card folder-card" data-folder-id="${folder.id}">
      <div class="folder-icon">${folderIcon()}</div>
      <div class="folder-info" data-action="open-folder">
        <div class="folder-name">${escapeHtml(folder.name)}</div>
        <div class="folder-meta">${meta.join(' · ') || 'Empty'}</div>
      </div>
      <button class="icon-btn folder-menu-btn" data-action="folder-menu" aria-label="Folder options" style="width:36px;height:36px;flex-shrink:0;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
      </button>
    </div>
  `;
}

function renderPromptCard(prompt) {
  const tags = (prompt.tags || []).map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('');
  return `
    <div class="prompt-block" data-prompt-id="${prompt.id}">
      <div class="prompt-header">
        <div class="prompt-title">${escapeHtml(prompt.title)}</div>
        <button class="prompt-fav ${prompt.isFavorite ? 'active' : ''}" data-action="toggle-fav" aria-label="Favorite">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="${prompt.isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </div>
      <div class="prompt-body" data-action="expand">
        ${escapeHtml(prompt.content)}
        <div class="prompt-fade"></div>
      </div>
      ${tags ? `<div class="prompt-tags">${tags}</div>` : ''}
      <div class="prompt-actions">
        <button class="copy-btn" data-action="copy">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy
        </button>
        <button data-action="edit">Edit</button>
        <button data-action="move-prompt">Move</button>
        <button data-action="share">Share</button>
        <button data-action="related">Related</button>
        <button class="danger" data-action="delete">Delete</button>
      </div>
    </div>
  `;
}

function renderLibraryCard(item) {
  const tags = (item.tags || []).map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('');
  const type = item.itemType || 'note';
  return `
    <div class="prompt-block" data-library-id="${item.id}">
      <div class="prompt-header">
        <div class="prompt-title">
          <span class="type-badge type-${escapeHtml(type)}">${escapeHtml(itemTypeLabel(type))}</span>
          ${escapeHtml(item.title)}
        </div>
        <button class="prompt-fav ${item.isFavorite ? 'active' : ''}" data-action="toggle-fav-lib" aria-label="Favorite">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="${item.isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </div>
      <div class="prompt-body" data-action="expand">
        ${escapeHtml(item.content)}
        <div class="prompt-fade"></div>
      </div>
      ${tags ? `<div class="prompt-tags">${tags}</div>` : ''}
      ${safeSourceUrl(item.sourceUrl) ? `<div class="prompt-tags"><a class="tag" href="${escapeHtml(safeSourceUrl(item.sourceUrl))}" target="_blank" rel="noopener noreferrer">Source</a></div>` : ''}
      <div class="prompt-actions">
        <button class="copy-btn" data-action="copy-lib">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy
        </button>
        <button data-action="edit-lib">Edit</button>
        <button data-action="move-lib">Move</button>
        <button data-action="share-lib">Share</button>
        <button data-action="related-lib">Related</button>
        <button class="danger" data-action="delete-lib">Delete</button>
      </div>
    </div>
  `;
}

async function renderFolderView() {
  const folderId = state.currentFolderId;
  const allFolders = await getAllFolders();
  const allPrompts = await getAllPrompts();
  const children = allFolders.filter(f => f.parentId === folderId);
  const prompts = allPrompts.filter(p => p.folderId === folderId).sort((a, b) => b.updatedAt - a.updatedAt);
  const libItems = (await getLibraryItemsByFolder(folderId)).sort((a, b) => b.updatedAt - a.updatedAt);
  const images = await getImagesByParent(folderId);

  const main = $('#main');
  const empty = prompts.length === 0 && libItems.length === 0 && children.length === 0 && images.length === 0;
  main.innerHTML = `
    ${children.length ? `<div class="section-title">Folders</div>${children.map(f => renderFolderCard(f, allFolders, allPrompts)).join('')}` : ''}
    ${prompts.length ? `<div class="section-title">Prompts (${prompts.length})</div><div class="prompts-grid">${prompts.map(p => renderPromptCard(p)).join('')}</div>` : ''}
    ${libItems.length ? `<div class="section-title">Library (${libItems.length})</div><div class="prompts-grid">${libItems.map(i => renderLibraryCard(i)).join('')}</div>` : ''}
    ${images.length ? `<div class="section-title">Images (${images.length})</div>
      <div class="images-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
        ${images.map(img => {
          const src = img.dataUrl || img.publicUrl || '';
          return `<div class="image-card" data-image-id="${img.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
            ${src ? `<img src="${src.replace(/"/g, '&quot;')}" alt="${escapeHtml(img.name || 'image')}" style="width:100%;height:120px;object-fit:cover;display:block;"/>` : '<div style="height:120px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">No preview</div>'}
            <div style="padding:8px 10px;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(img.name || 'Image')}</div>
          </div>`;
        }).join('')}
      </div>` : ''}
    ${empty ? `
      <div class="empty-state">
        <h3>This folder is empty</h3>
        <p>Tap the gold + button to add a prompt, research, strategy, image, or subfolder</p>
      </div>
    ` : ''}
  `;
  bindFolderCards();
  bindPromptCards();
  bindLibraryCards();
}

async function renderFavorites() {
  const favs = await getFavorites();
  const main = $('#main');
  main.innerHTML = `
    <div class="section-title">Favorites (${favs.length})</div>
    ${favs.length === 0 ? `<div class="empty-state"><h3>No favorites yet</h3><p>Star prompts you use often for quick access</p></div>` : `<div class="prompts-grid">${favs.map(p => renderPromptCard(p)).join('')}</div>`}
  `;
  bindPromptCards();
}

async function renderTags() {
  const prompts = await getAllPrompts();
  const tagMap = {};
  for (const p of prompts) {
    for (const t of (p.tags || [])) tagMap[t] = (tagMap[t] || 0) + 1;
  }
  const tags = Object.entries(tagMap).sort((a, b) => b[1] - a[1]);

  const main = $('#main');
  main.innerHTML = `
    <div class="section-title">All Tags</div>
    <div style="padding: 4px 0 20px;">
      ${tags.length === 0 ? '<div class="empty-state"><p>No tags yet. Add tags when creating prompts.</p></div>' : ''}
      ${tags.map(([tag, count]) => `
        <button class="tag-chip" data-tag="${escapeHtml(tag)}">
          #${escapeHtml(tag)} <span class="tag-count">${count}</span>
        </button>
      `).join('')}
    </div>
    <div id="tag-results"></div>
  `;
  $all('.tag-chip').forEach(el => {
    el.addEventListener('click', async () => {
      const tag = el.dataset.tag;
      const filtered = prompts.filter(p => (p.tags || []).includes(tag));
      $('#tag-results').innerHTML = `
        <div class="section-title">#${escapeHtml(tag)} (${filtered.length})</div>
        ${filtered.map(p => renderPromptCard(p)).join('')}
      `;
      bindPromptCards();
    });
  });
}

function renderSettings() {
  const { status, error, pending } = getSyncStatus();
  let effectiveStatus = status;
  if (status === 'synced' && pending > 0) effectiveStatus = 'syncing';
  const statusText = {
    synced: '✓ All changes synced',
    syncing: pending > 0 ? `↻ Syncing… ${pending} change${pending > 1 ? 's' : ''}` : '↻ Syncing…',
    offline: pending > 0
      ? `⚠ Offline — ${pending} change${pending > 1 ? 's' : ''} will sync when online`
      : '⚠ Offline — changes will sync when online',
    error: '! Sync error',
    unknown: CLOUD_ENABLED ? '—' : 'Cloud not configured',
  }[effectiveStatus] || '—';

  const main = $('#main');
  main.innerHTML = `
    <div class="section-title">Account</div>
    <div class="settings-group">
      ${state.user ? `
        <div class="settings-item">
          <span class="settings-label">Signed in as</span>
          <span class="settings-value">${escapeHtml(state.user.email)}</span>
        </div>
        <div class="settings-item" id="btn-signout">
          <span class="settings-label" style="color:var(--danger)">Sign Out</span>
        </div>
      ` : `
        <div class="settings-item" id="btn-goto-auth">
          <span class="settings-label">Sign In / Create Account</span>
          <span class="settings-value">Cloud sync</span>
        </div>
      `}
    </div>

    <div class="section-title">Sync</div>
    <div class="settings-group">
      <div class="settings-item">
        <span class="settings-label">Status</span>
        <span class="settings-value" id="settings-sync-status">${statusText}</span>
      </div>
      ${status === 'error' ? `
        <div class="settings-item" id="btn-retry-sync">
          <span class="settings-label" style="color:var(--accent)">Retry Sync</span>
        </div>
        <p style="padding:8px 16px 12px;font-size:13px;color:var(--text-muted);">${escapeHtml(error || '')}</p>
      ` : ''}
      ${status === 'offline' ? `
        <p style="padding:8px 16px 12px;font-size:13px;color:var(--text-muted);">
          You can keep working. Changes will upload automatically when you are back online.
        </p>
      ` : ''}
    </div>

    <div class="section-title">Appearance</div>
    <div class="settings-group">
      <div class="settings-item" id="toggle-theme-setting">
        <span class="settings-label">Theme</span>
        <span class="settings-value">${state.theme === 'dark' ? 'Dark' : 'Light'}</span>
      </div>
    </div>

    <div class="section-title">Data</div>
    <div class="settings-group">
      <div class="settings-item" id="btn-export">
        <span class="settings-label">Export Library</span>
        <span class="settings-value">JSON backup</span>
      </div>
      <div class="settings-item" id="btn-import">
        <span class="settings-label">Import Library</span>
        <span class="settings-value">JSON</span>
      </div>
      <div class="settings-item" id="btn-recently-deleted">
        <span class="settings-label">Recently Deleted</span>
        <span class="settings-value">Recover</span>
      </div>
      <div class="settings-item" id="btn-share-links">
        <span class="settings-label">My Share Links</span>
        <span class="settings-value">Manage</span>
      </div>
    </div>

    <div class="section-title">AI Connections (MCP)</div>
    <div class="settings-group">
      <div class="settings-item" id="copy-mcp-url">
        <span class="settings-label">Copy MCP endpoint</span>
        <span class="settings-value">Hosted URL</span>
      </div>
      <div class="settings-item" id="copy-mcp-token">
        <span class="settings-label">Copy access token</span>
        <span class="settings-value">Local / stdio only</span>
      </div>
      <div class="settings-item" style="cursor:default;flex-direction:column;align-items:flex-start;gap:8px;">
        <span class="settings-label">How to connect (ChatGPT / Claude / Cursor)</span>
        <span class="settings-value" style="white-space:normal;line-height:1.45;">
          <strong>Hosted MCP (recommended)</strong><br>
          Endpoint: <code>https://roys-s-digital-library-mcp.onrender.com/mcp</code><br>
          1. Add that URL as a remote / custom MCP connector<br>
          2. Complete OAuth sign-in when prompted<br>
          3. Use tools like search_library, create_library_item<br><br>
          <strong>Local stdio (optional)</strong><br>
          Copy access token → ROYS_ACCESS_TOKEN → run mcp-server/index.js<br>
          Token expires with session. Never share it.
        </span>
      </div>
    </div>

    <div class="section-title">About</div>
    <div class="settings-group">
      <div class="settings-item">
        <span class="settings-label">Roy's Digital Library</span>
        <span class="settings-value">v3.9.1 · Hosted MCP</span>
      </div>
    </div>
  `;

  $('#copy-mcp-url')?.addEventListener('click', async () => {
    try {
      const { MCP_ENDPOINT } = await import('./config.js');
      await copyText(MCP_ENDPOINT || 'https://roys-s-digital-library-mcp.onrender.com/mcp');
      toast('✓ MCP endpoint copied');
    } catch (e) {
      await copyText('https://roys-s-digital-library-mcp.onrender.com/mcp');
      toast('✓ MCP endpoint copied');
    }
  });

  $('#copy-mcp-token')?.addEventListener('click', async () => {
    try {
      const { getSupabase } = await import('./supabase.js');
      const sb = getSupabase();
      if (!sb) return toast('Cloud not configured');
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) return toast('Sign in first');
      await copyText(session.access_token);
      toast('✓ Token copied — for local stdio MCP only');
    } catch (e) {
      toast('Could not copy token');
    }
  });

  $('#toggle-theme-setting')?.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    renderSettings();
  });
  $('#btn-export')?.addEventListener('click', doExport);
  $('#btn-import')?.addEventListener('click', doImport);
  $('#btn-signout')?.addEventListener('click', signOut);
  $('#btn-goto-auth')?.addEventListener('click', () => { state.showAuth = true; render(); });
  $('#btn-retry-sync')?.addEventListener('click', async () => {
    if (state.user) await fullSync(state.user.id);
    renderSettings();
  });
  $('#btn-recently-deleted')?.addEventListener('click', renderRecentlyDeleted);
  $('#btn-share-links')?.addEventListener('click', renderShareLinks);
}

async function renderRecentlyDeleted() {
  const deleted = await getDeletedPrompts();
  const main = $('#main');
  main.innerHTML = `
    <div class="section-title">Recently Deleted (${deleted.length})</div>
    ${deleted.length === 0 ? '<div class="empty-state"><p>Nothing in the trash</p></div>' : ''}
    ${deleted.map(p => `
      <div class="prompt-block" data-prompt-id="${p.id}">
        <div class="prompt-header">
          <div class="prompt-title">${escapeHtml(p.title)}</div>
        </div>
        <div class="prompt-body">${escapeHtml(p.content.slice(0, 120))}…</div>
        <div class="prompt-actions">
          <button data-action="restore" style="color:var(--accent)">Restore</button>
          <button class="danger" data-action="purge">Delete Forever</button>
        </div>
      </div>
    `).join('')}
    <button class="btn btn-secondary" id="back-settings" style="margin-top:16px;width:100%;">Back to Settings</button>
  `;
  $all('[data-action="restore"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.prompt-block').dataset.promptId;
      await restorePrompt(id);
      toast('Restored');
      if (state.user) fullSync(state.user.id);
      renderRecentlyDeleted();
    });
  });
  $all('[data-action="purge"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.prompt-block').dataset.promptId;
      await deletePrompt(id, { soft: false });
      toast('Permanently deleted');
      renderRecentlyDeleted();
    });
  });
  $('#back-settings')?.addEventListener('click', () => { state.view = 'settings'; render(); });
}

// ── Bindings ──────────────────────────────────────────────────
function bindFolderCards() {
  $all('.folder-card').forEach(el => {
    const id = el.dataset.folderId;
    el.querySelector('[data-action="open-folder"]')?.addEventListener('click', () => navigateToFolder(id));
    el.querySelector('.folder-icon')?.addEventListener('click', () => navigateToFolder(id));
    el.querySelector('[data-action="folder-menu"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderActions(id);
    });
  });
}

async function renderShareLinks() {
  state.view = 'share-links';
  const main = $('#main');
  if (!state.user) {
    main.innerHTML = `<div class="empty-state"><h3>Sign in required</h3><p>Share links are stored in your cloud account.</p></div>`;
    return;
  }
  main.innerHTML = `<div class="section-title">My Share Links</div><p style="color:var(--text-muted);font-size:14px;margin:0 0 16px;">Active public links. Copy again or revoke anytime.</p><div id="share-links-list">Loading…</div>`;
  try {
    const shares = await listAllShares(state.user.id);
    const list = $('#share-links-list');
    if (!shares.length) {
      list.innerHTML = `<div class="empty-state"><h3>No active share links</h3><p>Open any prompt or library item and tap Share.</p></div>`;
      return;
    }
    list.innerHTML = shares.map(s => `
      <div class="settings-group" style="margin-bottom:12px;">
        <div class="settings-item" style="flex-direction:column;align-items:stretch;gap:8px;">
          <div style="font-weight:600;">${escapeHtml(s.title || 'Untitled')}</div>
          <div style="font-size:12px;color:var(--text-muted);word-break:break-all;">${escapeHtml(s.url)}</div>
          <div style="font-size:12px;color:var(--text-muted);">Created ${s.created_at ? new Date(s.created_at).toLocaleString() : '—'}</div>
          <div class="btn-row" style="margin-top:4px;">
            <button class="btn btn-secondary btn-sm" data-copy-share="${escapeHtml(s.url)}">Copy link</button>
            <button class="btn btn-danger btn-sm" data-revoke-share="${s.id}">Revoke</button>
          </div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('[data-copy-share]').forEach(btn => {
      btn.addEventListener('click', () => copyText(btn.dataset.copyShare));
    });
    list.querySelectorAll('[data-revoke-share]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this share link? Anyone with the link will lose access.')) return;
        try {
          await revokeShare(state.user.id, btn.dataset.revokeShare);
          toast('Share link revoked');
          renderShareLinks();
        } catch (e) {
          toast(e.message || 'Revoke failed');
        }
      });
    });
  } catch (e) {
    $('#share-links-list').innerHTML = `<p style="color:var(--danger);">${escapeHtml(e.message || 'Failed to load shares')}</p>`;
  }
}


async function openFolderActions(folderId) {
  if (folderId === 'root') return toast('Root folder cannot be changed');
  const folder = await getFolder(folderId);
  if (!folder) return;
  openModal(`
    <div class="modal-title">${escapeHtml(folder.name)}</div>
    <div class="action-list">
      <button class="action-item" data-action="rename-folder">Rename</button>
      <button class="action-item" data-action="move-folder">Move to…</button>
      <button class="action-item" data-action="delete-folder" style="color:var(--danger)">Delete folder</button>
    </div>
    <div class="btn-row" style="margin-top:12px;">
      <button class="btn btn-secondary" id="folder-act-close">Close</button>
    </div>
  `);
  $('#folder-act-close')?.addEventListener('click', closeModal);
  $all('[data-action="rename-folder"]').forEach(el => el.addEventListener('click', () => {
    closeModal();
    openFolderEditor(folder);
  }));
  $all('[data-action="move-folder"]').forEach(el => el.addEventListener('click', () => {
    closeModal();
    openMoveFolder(folder);
  }));
  $all('[data-action="delete-folder"]').forEach(el => el.addEventListener('click', () => {
    closeModal();
    confirmDeleteFolder(folder);
  }));
}

async function openMoveFolder(folder) {
  const folders = await getAllFolders();
  const forbidden = new Set([folder.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of folders) {
      if (forbidden.has(f.parentId) && !forbidden.has(f.id)) {
        forbidden.add(f.id);
        changed = true;
      }
    }
  }
  const options = [
    `<option value="root" ${folder.parentId === 'root' || folder.parentId == null ? 'selected' : ''}>Library root</option>`
  ].concat(
    folders
      .filter(f => f.id !== 'root' && !forbidden.has(f.id))
      .map(f => `<option value="${f.id}" ${folder.parentId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
  ).join('');

  openModal(`
    <div class="modal-title">Move “${escapeHtml(folder.name)}”</div>
    <div class="form-group">
      <label>New parent folder</label>
      <select id="move-parent">${options}</select>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-move">Cancel</button>
      <button class="btn btn-primary" id="save-move">Move</button>
    </div>
  `);
  $('#cancel-move').addEventListener('click', closeModal);
  $('#save-move').addEventListener('click', async () => {
    const parentId = $('#move-parent').value;
    folder.parentId = parentId === 'root' ? 'root' : parentId;
    folder.updatedAt = Date.now();
    await saveFolder(folder);
    closeModal();
    toast('Folder moved');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
}

function confirmDeleteFolder(folder) {
  openModal(`
    <div class="modal-title">Delete folder?</div>
    <p style="color:var(--text-secondary);margin-bottom:16px;font-size:14px;line-height:1.45;">
      “${escapeHtml(folder.name)}” and its subfolders will be soft-deleted.
    </p>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-del-f">Cancel</button>
      <button class="btn btn-danger" id="confirm-del-f">Delete</button>
    </div>
  `);
  $('#cancel-del-f').addEventListener('click', closeModal);
  $('#confirm-del-f').addEventListener('click', async () => {
    await softDeleteFolderCascade(folder.id);
    closeModal();
    toast('Folder deleted');
    if (state.view === 'folder' && state.currentFolderId === folder.id) {
      state.view = 'home';
      state.currentFolderId = 'root';
    }
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
}


function bindPromptCards() {
  $all('.prompt-block').forEach(block => {
    const id = block.dataset.promptId;
    block.querySelector('[data-action="copy"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = await getPrompt(id);
      if (p) {
        await copyText(p.content);
        p.lastUsedAt = Date.now();
        p.useCount = (p.useCount || 0) + 1;
        await savePrompt(p);
      }
    });
    block.querySelector('[data-action="edit"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = await getPrompt(id);
      if (p) openPromptEditor(p);
    });
    block.querySelector('[data-action="move-prompt"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = await getPrompt(id);
      if (p) openMovePrompt(p);
    });
    block.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      confirmDeletePrompt(id);
    });
    block.querySelector('[data-action="share"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = await getPrompt(id);
      if (p) openShareModal(p);
    });
    block.querySelector('[data-action="toggle-fav"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = await getPrompt(id);
      if (p) {
        p.isFavorite = !p.isFavorite;
        await savePrompt(p);
        toast(p.isFavorite ? 'Added to favorites' : 'Removed from favorites');
        if (state.user && navigator.onLine) fullSync(state.user.id);
        render();
      }
    });
    block.querySelector('[data-action="expand"]')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('expanded');
    });
  });
}

// ── Modals ────────────────────────────────────────────────────

function bindLibraryCards() {
  $all('[data-library-id]').forEach(block => {
    const id = block.dataset.libraryId;
    block.querySelector('[data-action="copy-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = await getLibraryItem(id);
      if (item) {
        await copyText(item.content);
        item.lastUsedAt = Date.now();
        item.useCount = (item.useCount || 0) + 1;
        await saveLibraryItem(item);
      }
    });
    block.querySelector('[data-action="move-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = await getLibraryItem(id);
      if (item) openMoveLibraryItem(item);
    });
    block.querySelector('[data-action="share-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = await getLibraryItem(id);
      if (item) openShareModal(item);
    });
    block.querySelector('[data-action="expand"]')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('expanded');
    });
    block.querySelector('[data-action="edit-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = await getLibraryItem(id);
      if (item) openLibraryEditor(item);
    });
    block.querySelector('[data-action="related-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      openRelatedModal('library_item', id);
    });
    block.querySelector('[data-action="delete-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      openModal(`
        <div class="modal-title">Delete item?</div>
        <p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">It will be soft-deleted and can be recovered later if needed.</p>
        <div class="btn-row">
          <button class="btn btn-secondary" id="cancel-del-lib">Cancel</button>
          <button class="btn btn-danger" id="confirm-del-lib">Delete</button>
        </div>
      `);
      $('#cancel-del-lib').addEventListener('click', closeModal);
      $('#confirm-del-lib').addEventListener('click', async () => {
        await deleteLibraryItem(id);
        await cleanupLinksForItem(id);
        closeModal();
        toast('Deleted');
        if (state.user && navigator.onLine) fullSync(state.user.id);
        render();
      });
    });
    block.querySelector('[data-action="toggle-fav-lib"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = await getLibraryItem(id);
      if (item) {
        item.isFavorite = !item.isFavorite;
        await saveLibraryItem(item);
        toast(item.isFavorite ? 'Added to favorites' : 'Removed from favorites');
        if (state.user && navigator.onLine) fullSync(state.user.id);
        render();
      }
    });
    block.querySelector('[data-action="expand"]')?.addEventListener('click', (e) => {
      e.currentTarget.classList.toggle('expanded');
    });
  });
}

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal-sheet"><div class="modal-handle"></div>${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}


async function openShareModal(prompt) {
  if (!state.user) {
    toast('Sign in to share prompts');
    return;
  }
  let existing = [];
  try {
    existing = await listSharesForPrompt(state.user.id, prompt.id);
  } catch (e) {
    console.warn(e);
  }

  const listHtml = existing.length
    ? existing.map(s => `
        <div style="padding:12px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;">
          <div style="font-size:12px;color:var(--text-muted);word-break:break-all;margin-bottom:8px;">${escapeHtml(s.url)}</div>
          <div class="btn-row">
            <button class="btn btn-secondary btn-copy-link" data-url="${escapeHtml(s.url)}" style="flex:1;">Copy link</button>
            <button class="btn btn-danger btn-revoke" data-id="${s.id}" style="flex:1;">Revoke</button>
          </div>
        </div>
      `).join('')
    : '<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">No active share links yet.</p>';

  openModal(`
    <div class="modal-title">Share link</div>
    <p style="font-size:14px;color:var(--text-secondary);margin-bottom:12px;line-height:1.45;">
      <strong>${escapeHtml(prompt.title)}</strong><br>
      Anyone with the link can view and copy this prompt. They cannot edit your library.
    </p>
    <div id="share-list">${listHtml}</div>
    <div class="btn-row" style="margin-top:12px;">
      <button class="btn btn-secondary" id="share-cancel">Close</button>
      <button class="btn btn-primary" id="share-create">Create link</button>
    </div>
    <div id="share-social" class="hidden" style="margin-top:14px;"></div>
  `);

  $('#share-cancel')?.addEventListener('click', closeModal);
  $('#share-create')?.addEventListener('click', async () => {
    try {
      const link = await createShareLink(state.user.id, prompt);
      toast('✓ Share link created');
      const social = $('#share-social');
      social.classList.remove('hidden');
      social.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);word-break:break-all;margin-bottom:10px;">${escapeHtml(link.url)}</div>
        <div class="btn-row">
          <button class="btn btn-primary" id="share-copy-new" style="flex:1;">Copy link</button>
        </div>
        <div class="btn-row" style="margin-top:8px;">
          <a class="btn btn-secondary" style="flex:1;text-align:center;text-decoration:none;line-height:48px;"
             href="https://wa.me/?text=${encodeURIComponent(prompt.title + ' — ' + link.url)}" target="_blank" rel="noopener">WhatsApp</a>
          <a class="btn btn-secondary" style="flex:1;text-align:center;text-decoration:none;line-height:48px;"
             href="mailto:?subject=${encodeURIComponent(prompt.title)}&body=${encodeURIComponent(link.url)}">Email</a>
        </div>
      `;
      $('#share-copy-new')?.addEventListener('click', async () => {
        await copyText(link.url);
      });
      if (navigator.share) {
        try {
          await navigator.share({ title: prompt.title, text: "Prompt from Roy's Library", url: link.url });
        } catch (_) {}
      }
      // refresh list area
      openShareModal(prompt);
    } catch (e) {
      toast(e.message || 'Share failed — run schema_share.sql in Supabase');
    }
  });

  $all('.btn-copy-link').forEach(btn => {
    btn.addEventListener('click', async () => {
      await copyText(btn.dataset.url);
    });
  });
  $all('.btn-revoke').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await revokeShare(state.user.id, btn.dataset.id);
        toast('Link revoked');
        openShareModal(prompt);
      } catch (e) {
        toast(e.message || 'Revoke failed');
      }
    });
  });
}


async function openMoveLibraryItem(item) {
  const folders = await getAllFolders();
  const options = folders.map(f =>
    `<option value="${f.id}" ${f.id === item.folderId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`
  ).join('');
  openModal(`
    <div class="modal-title">Move ${escapeHtml(itemTypeLabel(item.itemType || 'note'))}</div>
    <label class="field-label">Folder</label>
    <select id="move-lib-folder">${options}</select>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-secondary" id="cancel-ml">Cancel</button>
      <button class="btn btn-primary" id="save-ml">Move</button>
    </div>
  `);
  $('#cancel-ml').addEventListener('click', closeModal);
  $('#save-ml').addEventListener('click', async () => {
    item.folderId = $('#move-lib-folder').value;
    item.updatedAt = Date.now();
    await saveLibraryItem(item);
    closeModal();
    toast('Moved');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
}

async function openMovePrompt(prompt) {
  const folders = await getAllFolders();
  const opts = folders.filter(f => f.id !== 'root')
    .map(f => `<option value="${f.id}" ${prompt.folderId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
    .join('');
  openModal(`
    <div class="modal-title">Move prompt</div>
    <div class="form-group">
      <label>Folder</label>
      <select id="move-prompt-folder">${opts || '<option value="root">Root</option>'}</select>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-mp">Cancel</button>
      <button class="btn btn-primary" id="save-mp">Move</button>
    </div>
  `);
  $('#cancel-mp').addEventListener('click', closeModal);
  $('#save-mp').addEventListener('click', async () => {
    prompt.folderId = $('#move-prompt-folder').value || 'root';
    prompt.updatedAt = Date.now();
    await savePrompt(prompt);
    closeModal();
    toast('Prompt moved');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
}


async function cleanupLinksForItem(itemId) {
  try {
    const links = await getLinksForItem(itemId);
    for (const l of links) {
      await deleteItemLink(l.id);
    }
  } catch (e) {
    console.warn('[links] cleanup', e);
  }
}

async function openRelatedModal(kind, itemId) {
  const links = await getLinksForItem(itemId);
  const prompts = await getAllPrompts();
  const libItems = await getAllLibraryItems();
  const titleOf = async (k, id) => {
    if (k === 'prompt') {
      const p = prompts.find(x => x.id === id) || await getPrompt(id);
      return p ? p.title : id.slice(0, 8);
    }
    const i = libItems.find(x => x.id === id) || await getLibraryItem(id);
    return i ? `[${itemTypeLabel(i.itemType)}] ${i.title}` : id.slice(0, 8);
  };

  const rows = [];
  for (const l of links) {
    const otherKind = l.fromId === itemId ? l.toKind : l.fromKind;
    const otherId = l.fromId === itemId ? l.toId : l.fromId;
    const title = await titleOf(otherKind, otherId);
    rows.push(`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:14px;">${escapeHtml(title)}</span>
      <button class="btn btn-danger" data-unlink="${l.id}" style="flex:none;height:36px;padding:0 12px;">Unlink</button>
    </div>`);
  }

  const choices = [
    ...prompts.filter(p => p.id !== itemId).map(p => `<option value="prompt:${p.id}">Prompt — ${escapeHtml(p.title)}</option>`),
    ...libItems.filter(i => i.id !== itemId).map(i => `<option value="library_item:${i.id}">${escapeHtml(itemTypeLabel(i.itemType))} — ${escapeHtml(i.title)}</option>`),
  ].join('');

  openModal(`
    <div class="modal-title">Related items</div>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Link research, strategies, and prompts together. Deleting a link does not delete either item.</p>
    <div id="related-list">${rows.length ? rows.join('') : '<p style="font-size:13px;color:var(--text-muted);">No links yet.</p>'}</div>
    <div class="form-group" style="margin-top:16px;">
      <label>Add link to</label>
      <select id="related-target"><option value="">Choose…</option>${choices}</select>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="related-close">Close</button>
      <button class="btn btn-primary" id="related-add">Add link</button>
    </div>
  `);
  $('#related-close')?.addEventListener('click', closeModal);
  $all('[data-unlink]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteItemLink(btn.dataset.unlink);
      toast('Link removed');
      if (state.user && navigator.onLine) fullSync(state.user.id);
      openRelatedModal(kind, itemId);
    });
  });
  $('#related-add')?.addEventListener('click', async () => {
    const val = $('#related-target').value;
    if (!val) return toast('Choose an item');
    const [toKind, toId] = val.split(':');
    // prevent duplicate
    const exists = links.some(l =>
      (l.fromId === itemId && l.toId === toId) || (l.toId === itemId && l.fromId === toId)
    );
    if (exists) return toast('Already linked');
    await saveItemLink({
      id: uid(),
      fromId: itemId,
      fromKind: kind,
      toId,
      toKind,
      label: '',
      createdAt: Date.now(),
    });
    toast('Linked');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    openRelatedModal(kind, itemId);
  });
}

function openQuickAdd() {
  openModal(`
    <div class="modal-title">Quick Add</div>
    <div class="action-list">
      <button class="action-item" data-action="new-folder">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        New Folder
      </button>
      <button class="action-item" data-action="new-prompt">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        New Prompt
      </button>
      <button class="action-item" data-action="new-research">Research</button>
      <button class="action-item" data-action="new-strategy">Strategy</button>
      <button class="action-item" data-action="new-idea">Idea</button>
      <button class="action-item" data-action="new-note">Note</button>
      <button class="action-item" data-action="new-resource">Resource</button>
      <button class="action-item" data-action="new-template">Template</button>
      <button class="action-item" data-action="add-image">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add Image
      </button>
    </div>
  `);
  $all('[data-action="new-folder"]').forEach(el => el.addEventListener('click', () => { closeModal(); openFolderEditor(); }));
  $all('[data-action="new-prompt"]').forEach(el => el.addEventListener('click', () => { closeModal(); openPromptEditor(); }));
  $all('[data-action="new-research"]').forEach(el => el.addEventListener('click', () => { closeModal(); openLibraryEditor(null, 'research'); }));
  $all('[data-action="new-strategy"]').forEach(el => el.addEventListener('click', () => { closeModal(); openLibraryEditor(null, 'strategy'); }));
  $all('[data-action="new-idea"]').forEach(el => el.addEventListener('click', () => { closeModal(); openLibraryEditor(null, 'idea'); }));
  $all('[data-action="new-note"]').forEach(el => el.addEventListener('click', () => { closeModal(); openLibraryEditor(null, 'note'); }));
  $all('[data-action="new-resource"]').forEach(el => el.addEventListener('click', () => { closeModal(); openLibraryEditor(null, 'resource'); }));
  $all('[data-action="new-template"]').forEach(el => el.addEventListener('click', () => { closeModal(); openLibraryEditor(null, 'template'); }));
  $all('[data-action="add-image"]').forEach(el => el.addEventListener('click', () => { closeModal(); openImagePicker(); }));
}

async function openFolderEditor(folder = null) {
  const isEdit = !!folder;
  const folders = await getAllFolders();
  const currentParent = folder?.parentId || (state.view === 'folder' ? state.currentFolderId : 'root');
  const forbidden = new Set(folder ? [folder.id] : []);
  if (folder) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) {
        if (forbidden.has(f.parentId) && !forbidden.has(f.id)) { forbidden.add(f.id); changed = true; }
      }
    }
  }
  const parentOpts = [
    `<option value="root" ${currentParent === 'root' || !currentParent ? 'selected' : ''}>Library root</option>`
  ].concat(
    folders.filter(f => f.id !== 'root' && !forbidden.has(f.id))
      .map(f => `<option value="${f.id}" ${currentParent === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
  ).join('');

  openModal(`
    <div class="modal-title">${isEdit ? 'Rename / Edit Folder' : 'New Folder'}</div>
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="folder-name" value="${escapeHtml(folder?.name || '')}" placeholder="e.g. Cold Outreach" autofocus />
    </div>
    <div class="form-group">
      <label>Parent folder</label>
      <select id="folder-parent">${parentOpts}</select>
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-folder">Cancel</button>
      <button class="btn btn-primary" id="save-folder">Save</button>
    </div>
  `);
  $('#cancel-folder').addEventListener('click', closeModal);
  $('#save-folder').addEventListener('click', async () => {
    const name = $('#folder-name').value.trim();
    if (!name) return toast('Enter a name');
    const parentId = $('#folder-parent').value || 'root';
    const f = folder || { id: uid(), createdAt: Date.now() };
    f.name = name;
    f.parentId = parentId;
    f.updatedAt = Date.now();
    await saveFolder(f);
    closeModal();
    toast(isEdit ? 'Folder updated' : 'Folder created');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
  setTimeout(() => $('#folder-name')?.focus(), 100);
}

async function openPromptEditor(prompt = null) {
  const isEdit = !!prompt;
  const folders = await getAllFolders();
  const folderOptions = folders
    .filter(f => f.id !== 'root')
    .map(f => `<option value="${f.id}" ${(prompt?.folderId || state.currentFolderId) === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
    .join('');

  openModal(`
    <div class="modal-title">${isEdit ? 'Edit Prompt' : 'New Prompt'}</div>
    <div class="form-group">
      <label>Title</label>
      <input type="text" id="prompt-title" value="${escapeHtml(prompt?.title || '')}" placeholder="e.g. Cold Outreach — Short" />
    </div>
    <div class="form-group">
      <label>Prompt</label>
      <textarea id="prompt-content" placeholder="Write your prompt here…">${escapeHtml(prompt?.content || '')}</textarea>
    </div>
    <div class="form-group">
      <label>Folder</label>
      <select id="prompt-folder">${folderOptions}</select>
    </div>
    <div class="form-group">
      <label>Tags (comma separated)</label>
      <input type="text" id="prompt-tags" value="${escapeHtml((prompt?.tags || []).join(', '))}" placeholder="outreach, sales, ugc" />
    </div>
    <div class="form-group">
      <label>Notes (optional)</label>
      <input type="text" id="prompt-notes" value="${escapeHtml(prompt?.notes || '')}" placeholder="Internal notes…" />
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-prompt">Cancel</button>
      <button class="btn btn-primary" id="save-prompt">Save</button>
    </div>
  `);
  $('#cancel-prompt').addEventListener('click', closeModal);
  $('#save-prompt').addEventListener('click', async () => {
    const title = $('#prompt-title').value.trim();
    const content = $('#prompt-content').value.trim();
    if (!title || !content) return toast('Title and prompt required');
    const tags = $('#prompt-tags').value.split(',').map(t => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
    const p = prompt || { id: uid(), isFavorite: false, createdAt: Date.now() };
    p.title = title;
    p.content = content;
    p.folderId = $('#prompt-folder').value;
    p.tags = tags;
    p.notes = $('#prompt-notes').value.trim();
    p.updatedAt = Date.now();
    await savePrompt(p);
    closeModal();
    toast(isEdit ? 'Prompt updated' : 'Prompt saved');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
  setTimeout(() => $('#prompt-title')?.focus(), 100);
}

function confirmDeletePrompt(id) {
  openModal(`
    <div class="modal-title">Delete Prompt?</div>
    <p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">It will move to Recently Deleted and can be recovered.</p>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-del">Cancel</button>
      <button class="btn btn-danger" id="confirm-del">Delete</button>
    </div>
  `);
  $('#cancel-del').addEventListener('click', closeModal);
  $('#confirm-del').addEventListener('click', async () => {
    await deletePrompt(id);
    closeModal();
    toast('Moved to Recently Deleted');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
}


async function openLibraryEditor(item = null, defaultType = 'note') {
  const isEdit = !!item;
  const folders = await getAllFolders();
  const folderOptions = folders
    .filter(f => f.id !== 'root')
    .map(f => `<option value="${f.id}" ${(item?.folderId || state.currentFolderId) === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
    .join('');
  const typeOpts = ITEM_TYPES.filter(t => t.id !== 'prompt').map(t =>
    `<option value="${t.id}" ${(item?.itemType || defaultType) === t.id ? 'selected' : ''}>${t.label}</option>`
  ).join('');

  openModal(`
    <div class="modal-title">${isEdit ? 'Edit item' : 'New library item'}</div>
    <div class="form-group">
      <label>Type</label>
      <select id="lib-type">${typeOpts}</select>
    </div>
    <div class="form-group">
      <label>Title</label>
      <input type="text" id="lib-title" value="${escapeHtml(item?.title || '')}" placeholder="Title" />
    </div>
    <div class="form-group">
      <label>Content</label>
      <textarea id="lib-content" placeholder="Write your content…">${escapeHtml(item?.content || '')}</textarea>
    </div>
    <div class="form-group">
      <label>Folder</label>
      <select id="lib-folder">${folderOptions || '<option value="root">Root</option>'}</select>
    </div>
    <div class="form-group">
      <label>Tags (comma separated)</label>
      <input type="text" id="lib-tags" value="${escapeHtml((item?.tags || []).join(', '))}" placeholder="research, market" />
    </div>
    <div class="form-group">
      <label>Source URL (optional)</label>
      <input type="url" id="lib-source" value="${escapeHtml(item?.sourceUrl || '')}" placeholder="https://…" />
    </div>
    <div class="form-group">
      <label>Notes (optional)</label>
      <input type="text" id="lib-notes" value="${escapeHtml(item?.notes || '')}" placeholder="Internal notes…" />
    </div>
    <div class="btn-row">
      <button class="btn btn-secondary" id="cancel-lib">Cancel</button>
      <button class="btn btn-primary" id="save-lib">Save</button>
    </div>
  `);
  $('#cancel-lib').addEventListener('click', closeModal);
  $('#save-lib').addEventListener('click', async () => {
    const title = $('#lib-title').value.trim();
    const content = $('#lib-content').value.trim();
    if (!title) return toast('Title required');
    const tags = $('#lib-tags').value.split(',').map(x => x.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
    const row = item || { id: uid(), isFavorite: false, createdAt: Date.now() };
    row.title = title;
    row.content = content;
    row.itemType = $('#lib-type').value;
    row.folderId = $('#lib-folder').value || 'root';
    row.tags = tags;
    row.sourceUrl = $('#lib-source').value.trim();
    row.notes = $('#lib-notes').value.trim();
    row.updatedAt = Date.now();
    await saveLibraryItem(row);
    closeModal();
    toast(isEdit ? 'Item updated' : 'Item saved');
    if (state.user && navigator.onLine) fullSync(state.user.id);
    render();
  });
  setTimeout(() => $('#lib-title')?.focus(), 100);
}

function openImagePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files];
    const MAX = 5 * 1024 * 1024; // 5 MB
    const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    for (const file of files) {
      if (!ALLOWED.has(file.type)) {
        toast(`Skipped ${file.name}: unsupported type`);
        continue;
      }
      if (file.size > MAX) {
        toast(`Skipped ${file.name}: over 5 MB`);
        continue;
      }
      const dataUrl = await readFileAsDataURL(file);
      const img = {
        id: uid(),
        parentId: state.currentFolderId || 'root',
        name: file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120),
        dataUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await saveImage(img);
      if (state.user && navigator.onLine) {
        try {
          await uploadImageToStorage(img, state.user.id);
          await fullSync(state.user.id);
        } catch (e) {
          console.warn('Image upload deferred', e);
        }
      }
    }
    toast(`${files.length} image${files.length > 1 ? 's' : ''} added`);
    render();
  };
  input.click();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Search ────────────────────────────────────────────────────
function openSearch() {
  $('#search-overlay').classList.remove('hidden');
  const input = $('#search-input');
  input.value = '';
  input.focus();
  $('#search-results').innerHTML = '';
}

function closeSearch() {
  $('#search-overlay').classList.add('hidden');
}

async function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) { $('#search-results').innerHTML = ''; return; }
  const [folders, prompts] = await Promise.all([getAllFolders(), getAllPrompts()]);
  const results = [];
  for (const f of folders) {
    if (f.id === 'root') continue;
    if (f.name.toLowerCase().includes(q)) {
      results.push({ type: 'folder', id: f.id, title: f.name, path: await getFolderPath(f.id) });
    }
  }
  for (const p of prompts) {
    if (p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.includes(q)) || (p.notes || '').toLowerCase().includes(q)) {
      results.push({ type: 'prompt', id: p.id, title: p.title, path: await getFolderPath(p.folderId) });
    }
  }
  $('#search-results').innerHTML = results.length === 0
    ? `<div class="empty-state"><p>No results for “${escapeHtml(query)}”</p></div>`
    : results.map(r => `
        <div class="search-result" data-type="${r.type}" data-id="${r.id}">
          <div class="search-result-title">${escapeHtml(r.title)}</div>
          <div class="search-result-path">${escapeHtml(r.path)}</div>
        </div>
      `).join('');
  $all('.search-result').forEach(el => {
    el.addEventListener('click', async () => {
      closeSearch();
      if (el.dataset.type === 'folder') navigateToFolder(el.dataset.id);
      else {
        const p = await getPrompt(el.dataset.id);
        if (p) await navigateToFolder(p.folderId);
      }
    });
  });
}

async function getFolderPath(folderId) {
  const parts = [];
  let id = folderId;
  while (id && id !== 'root') {
    const f = await getFolder(id);
    if (!f) break;
    parts.unshift(f.name);
    id = f.parentId;
  }
  return "Roy's / " + parts.join(' / ');
}

// ── Export / Import ───────────────────────────────────────────
async function doExport() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `roys-prompt-library-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported!');
}

function doImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    try {
      const text = await input.files[0].text();
      const data = JSON.parse(text);
      if (!data.folders || !data.prompts) throw new Error('Invalid file');
      openModal(`
        <div class="modal-title">Import Library?</div>
        <p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">
          This will replace current local data (${data.prompts.length} prompts). Cloud will be updated on next sync.
        </p>
        <div class="btn-row">
          <button class="btn btn-secondary" id="cancel-import">Cancel</button>
          <button class="btn btn-primary" id="confirm-import">Import</button>
        </div>
      `);
      $('#cancel-import').addEventListener('click', closeModal);
      $('#confirm-import').addEventListener('click', async () => {
        await importAll(data);
        closeModal();
        toast('Library imported');
        if (state.user) await fullSync(state.user.id);
        state.view = 'home';
        render();
      });
    } catch (e) {
      toast('Invalid file');
    }
  };
  input.click();
}

// ── Main render ───────────────────────────────────────────────
async function render() {
  if (!state.authReady) return;
  if (state.showAuth && CLOUD_ENABLED) {
    renderAuth();
    updateTopbar();
    return;
  }

  updateTopbar();
  $all('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === state.view);
  });

  switch (state.view) {
    case 'home': await renderHome(); break;
    case 'folder': await renderFolderView(); break;
    case 'favorites': await renderFavorites(); break;
    case 'tags': await renderTags(); break;
    case 'settings': renderSettings(); break;
  }
}

// ── Init ──────────────────────────────────────────────────────
window.__roysGetAccessToken = async () => {
  const { getSupabase } = await import('./supabase.js');
  const sb = getSupabase();
  if (!sb) return null;
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token || null;
};

async function init() {
  applyTheme();
  await openDB();

  // Inject sync indicator into topbar if not present
  if (!$('#sync-indicator')) {
    const actions = $('.topbar-actions');
    if (actions) {
      const badge = document.createElement('span');
      badge.id = 'sync-indicator';
      badge.className = 'sync-indicator';
      actions.insertBefore(badge, actions.firstChild);
    }
  }

  await initAuth();

  if (!CLOUD_ENABLED || !state.showAuth) {
    await seedIfEmpty();
  }

  onSyncStatusChange(() => updateTopbar());

  $('#btn-back').addEventListener('click', goBack);
  $('#btn-theme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  $('#btn-search').addEventListener('click', openSearch);
  $('#btn-search-close').addEventListener('click', closeSearch);
  $('#search-input').addEventListener('input', (e) => runSearch(e.target.value));

  $all('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => {
      state.view = el.dataset.view;
      if (state.view === 'home') state.currentFolderId = 'root';
      render();
    });
  });
  $('#btn-quick-add').addEventListener('click', openQuickAdd);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openSearch();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Existing-session bootstrap is handled inside initAuth() after getSession().
  // Fresh sign-in is handled by onAuthStateChange(SIGNED_IN).
  // If no user yet, just render the auth/home UI.
  if (!state.user) {
    await render();
  }
  // If state.user is set, onSignedIn() already ran (or is running) from initAuth.
}

init();
