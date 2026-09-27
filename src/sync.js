/**
 * Roy's Digital Library — Sync Engine v2.1
 *
 * Architecture:
 *   UI → IndexedDB (local cache + pending queue) → this module → Supabase
 *
 * Conflict rule (deterministic):
 *   For any record with the same id, the version with the higher updatedAt wins.
 *   Soft-deletes (deletedAt set) are treated as updates; an older device cannot
 *   resurrect a record that a newer device has soft-deleted.
 *
 * Offline:
 *   All writes go to IndexedDB + pending queue immediately.
 *   On reconnect, pending is pushed first, then a merge-pull runs.
 */

import { getSupabase, CLOUD_ENABLED } from './supabase.js';
import {
  getAllFolders, getAllPrompts, getPending, clearPending,
  saveFolder, savePrompt, saveImage,
  saveLibraryItem, getAllLibraryItems,
  saveItemLink, deleteItemLink, getAllItemLinks,
  getMeta, setMeta
} from './db.js';

let syncStatus = 'unknown'; // synced | syncing | offline | error
let lastError = null;
let pendingCount = 0;
let realtimeChannels = [];
let statusListeners = [];
let networkListenersBound = false;
let syncInProgress = false;
let currentUserId = null;
let onChangeCallback = null;

export function getSyncStatus() {
  return { status: syncStatus, error: lastError, pending: pendingCount };
}

export function onSyncStatusChange(fn) {
  statusListeners.push(fn);
  return () => { statusListeners = statusListeners.filter(f => f !== fn); };
}

function setStatus(status, error = null) {
  syncStatus = status;
  lastError = error;
  statusListeners.forEach(fn => fn({ status, error, pending: pendingCount }));
}

function isOnline() {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

async function refreshPendingCount() {
  const pending = await getPending();
  pendingCount = pending.length;
  return pendingCount;
}

// ── Field mapping ─────────────────────────────────────────────
function toCloudFolder(f, userId) {
  return {
    id: f.id,
    user_id: userId,
    name: f.name,
    parent_id: f.parentId ?? null,
    created_at: f.createdAt || Date.now(),
    updated_at: f.updatedAt || Date.now(),
    deleted_at: f.deletedAt ?? null,
  };
}

function fromCloudFolder(row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || undefined,
  };
}

function toCloudPrompt(p, userId) {
  return {
    id: p.id,
    user_id: userId,
    folder_id: p.folderId,
    title: p.title,
    content: p.content,
    tags: p.tags || [],
    notes: p.notes || '',
    is_favorite: !!p.isFavorite,
    created_at: p.createdAt || Date.now(),
    updated_at: p.updatedAt || Date.now(),
    deleted_at: p.deletedAt ?? null,
  };
}

function fromCloudPrompt(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    content: row.content,
    tags: row.tags || [],
    notes: row.notes || '',
    isFavorite: !!row.is_favorite,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || undefined,
  };
}

function toCloudImage(img, userId) {
  return {
    id: img.id,
    user_id: userId,
    parent_id: img.parentId,
    name: img.name,
    storage_path: img.storage_path || img.storagePath || '',
    created_at: img.createdAt || Date.now(),
    updated_at: img.updatedAt || Date.now(),
    deleted_at: img.deletedAt ?? null,
  };
}

function fromCloudImage(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    storage_path: row.storage_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || undefined,
  };
}

/**
 * Merge rule: higher updatedAt wins.
 * If equal, prefer the one that has deletedAt set (delete wins on tie).
 */

function toCloudLibraryItem(item, userId) {
  return {
    id: item.id,
    user_id: userId,
    folder_id: item.folderId,
    item_type: item.itemType || 'note',
    title: item.title,
    content: item.content || '',
    tags: item.tags || [],
    notes: item.notes || '',
    source_url: item.sourceUrl || '',
    metadata: item.metadata || {},
    is_favorite: !!item.isFavorite,
    created_at: item.createdAt || Date.now(),
    updated_at: item.updatedAt || Date.now(),
    deleted_at: item.deletedAt ?? null,
  };
}

function fromCloudLibraryItem(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    itemType: row.item_type || 'note',
    title: row.title,
    content: row.content || '',
    tags: row.tags || [],
    notes: row.notes || '',
    sourceUrl: row.source_url || '',
    metadata: row.metadata || {},
    isFavorite: !!row.is_favorite,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || undefined,
  };
}

function shouldPreferCloud(local, cloud) {
  if (!local) return true;
  if (!cloud) return false;
  const lu = local.updatedAt || 0;
  const cu = cloud.updatedAt || 0;
  if (cu > lu) return true;
  if (cu < lu) return false;
  // tie: prefer deleted
  if (cloud.deletedAt && !local.deletedAt) return true;
  return false;
}

// ── Deduplicate pending queue by entity+payload.id+action ─────
async function getDedupedPending() {
  const pending = await getPending();
  // Keep the newest entry per (entity, payload.id, action)
  const map = new Map();
  for (const item of pending) {
    const key = `${item.entity}:${item.payload?.id || 'x'}:${item.action}`;
    const existing = map.get(key);
    if (!existing || (item.createdAt || 0) >= (existing.createdAt || 0)) {
      map.set(key, item);
    }
  }
  // Clear older duplicates
  const keepIds = new Set([...map.values()].map(i => i.id));
  for (const item of pending) {
    if (!keepIds.has(item.id)) {
      await clearPending(item.id);
    }
  }
  return [...map.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// ── Push pending queue ────────────────────────────────────────
async function pushPending(userId) {
  const supabase = getSupabase();
  if (!supabase) return;

  const pending = await getDedupedPending();
  await refreshPendingCount();
  if (!pending.length) return;

  const failures = [];

  for (const item of pending) {
    try {
      if (item.entity === 'folder') {
        if (item.action === 'upsert') {
          const { error } = await supabase.from('folders').upsert(toCloudFolder(item.payload, userId));
          if (error) throw error;
        } else if (item.action === 'delete') {
          const { error } = await supabase.from('folders')
            .update({ deleted_at: item.payload.deletedAt, updated_at: item.payload.deletedAt || Date.now() })
            .eq('id', item.payload.id).eq('user_id', userId);
          if (error) throw error;
        }
      } else if (item.entity === 'prompt') {
        if (item.action === 'upsert') {
          const { error } = await supabase.from('prompts').upsert(toCloudPrompt(item.payload, userId));
          if (error) throw error;
        } else if (item.action === 'delete') {
          const { error } = await supabase.from('prompts')
            .update({ deleted_at: item.payload.deletedAt, updated_at: item.payload.deletedAt || Date.now() })
            .eq('id', item.payload.id).eq('user_id', userId);
          if (error) throw error;
        }
      } else if (item.entity === 'image') {
        if (item.action === 'upsert') {
          let payload = { ...item.payload };
          // Binary must land in Storage before metadata is written
          if (payload.dataUrl && !payload.storage_path) {
            payload = await uploadImageToStorage(payload, userId);
            if (!payload.storage_path) {
              throw new Error('Image storage upload failed — keeping pending');
            }
          }
          const { error } = await supabase.from('images').upsert(toCloudImage(payload, userId));
          if (error) throw error;
        } else if (item.action === 'delete') {
          const { error } = await supabase.from('images')
            .update({ deleted_at: item.payload.deletedAt, updated_at: item.payload.deletedAt || Date.now() })
            .eq('id', item.payload.id).eq('user_id', userId);
          if (error) throw error;
        }
      } else if (item.entity === 'library_item') {
        if (item.action === 'upsert') {
          const { error } = await supabase.from('library_items').upsert(toCloudLibraryItem(item.payload, userId));
          if (error) throw error;
        } else if (item.action === 'delete') {
          const { error } = await supabase.from('library_items')
            .update({ deleted_at: item.payload.deletedAt, updated_at: item.payload.deletedAt || Date.now() })
            .eq('id', item.payload.id).eq('user_id', userId);
          if (error) throw error;
        }
      } else if (item.entity === 'item_link') {
        if (item.action === 'upsert') {
          const p = item.payload;
          const { error } = await supabase.from('item_links').upsert({
            id: p.id,
            user_id: userId,
            from_id: p.fromId,
            from_kind: p.fromKind,
            to_id: p.toId,
            to_kind: p.toKind,
            label: p.label || '',
            created_at: p.createdAt || Date.now(),
          });
          if (error) throw error;
        } else if (item.action === 'delete') {
          const { error } = await supabase.from('item_links').delete().eq('id', item.payload.id).eq('user_id', userId);
          if (error) throw error;
        }
      }
      // Only remove from queue after confirmed success
      await clearPending(item.id);
    } catch (err) {
      console.error('[sync] push failed', item.entity, item.payload?.id, err);
      failures.push({ item, err });
      // Continue processing other items — do not abort the whole queue
    }
  }

  await refreshPendingCount();

  if (failures.length && failures.length === pending.length) {
    // Every item failed
    throw failures[0].err;
  }
}

// ── Merge pull (last-write-wins, preserves newer local) ───────
async function pullAndMerge(userId) {
  const supabase = getSupabase();
  if (!supabase) return;

  const [foldersRes, promptsRes, imagesRes, libRes] = await Promise.all([
    supabase.from('folders').select('*').eq('user_id', userId),
    supabase.from('prompts').select('*').eq('user_id', userId),
    supabase.from('images').select('*').eq('user_id', userId),
    supabase.from('library_items').select('*').eq('user_id', userId),
  ]);

  if (foldersRes.error) throw foldersRes.error;
  if (promptsRes.error) throw promptsRes.error;
  if (imagesRes.error) throw imagesRes.error;
  // library_items may not exist yet if schema_library.sql not run — soft fail
  const cloudLib = (!libRes.error && libRes.data) ? libRes.data.map(fromCloudLibraryItem) : [];

  const cloudFolders = (foldersRes.data || []).map(fromCloudFolder);
  const cloudPrompts = (promptsRes.data || []).map(fromCloudPrompt);
  const cloudImages = (imagesRes.data || []).map(fromCloudImage);

  // Load ALL local records including soft-deleted for proper merge
  const { openDB } = await import('./db.js');
  await openDB();

  // Use save* with fromCloud after comparing updatedAt
  // Build local maps from active helpers + we need deleted too.
  // getAllFolders filters deleted; for merge we need full store.
  // We'll fetch via a lightweight approach: save only when cloud is newer.

  // Merge folders (including soft-deleted locals)
  const { getFolderAny, getPromptAny, getAllImagesRaw } = await import('./db.js');
  for (const cloud of cloudFolders) {
    const local = await getFolderAny(cloud.id);
    if (shouldPreferCloud(local, cloud)) {
      await saveFolder(cloud, { fromCloud: true });
    }
  }

  for (const cloud of cloudPrompts) {
    const local = await getPromptAny(cloud.id);
    if (shouldPreferCloud(local, cloud)) {
      await savePrompt(cloud, { fromCloud: true });
    }
  }

  // Images: compare updatedAt when local exists
  let localImages = [];
  try { localImages = await getAllImagesRaw(); } catch (_) {}
  const localImgMap = new Map(localImages.map(i => [i.id, i]));
  for (const cloud of cloudImages) {
    const local = localImgMap.get(cloud.id);
    if (shouldPreferCloud(local, cloud)) {
      // Preserve local dataUrl if cloud has none
      const merged = { ...cloud };
      if (local?.dataUrl && !merged.dataUrl) merged.dataUrl = local.dataUrl;
      await saveImage(merged, { fromCloud: true });
    }
  }

  // Library items LWW merge
  const { getLibraryItemAny } = await import('./db.js');
  for (const cloud of cloudLib) {
    const local = await getLibraryItemAny(cloud.id);
    if (shouldPreferCloud(local, cloud)) {
      await saveLibraryItem(cloud, { fromCloud: true });
    }
  }

  // Item links pull.
  //
  // v3.9 fix: item_links has no updatedAt, so it can't use the normal LWW
  // merge the other entities use — the old code treated "not present in
  // this cloud snapshot" as "delete it locally", which also fired for a
  // link that was created locally moments ago and simply hadn't been
  // pushed yet (or whose push had failed and was sitting retryable in the
  // pending queue). That silently destroyed a pending local change on
  // every pull. The fix borrows the same "a pending change wins over a
  // cloud snapshot that doesn't reflect it yet" principle the pending
  // queue already encodes for every other entity: don't let a pull delete
  // (or resurrect) a link that still has an un-pushed create/delete
  // sitting in the local pending queue. A link with no pending change and
  // no matching cloud row really was deleted remotely, so that case still
  // propagates the deletion exactly as before.
  try {
    const linksRes = await supabase.from('item_links').select('*').eq('user_id', userId);
    if (!linksRes.error && linksRes.data) {
      const localLinks = await getAllItemLinks();
      const cloudIds = new Set(linksRes.data.map(r => r.id));

      const pending = await getPending();
      const pendingCreateIds = new Set(
        pending.filter(p => p.entity === 'item_link' && p.action === 'upsert').map(p => p.payload?.id)
      );
      const pendingDeleteIds = new Set(
        pending.filter(p => p.entity === 'item_link' && p.action === 'delete').map(p => p.payload?.id)
      );

      for (const row of linksRes.data) {
        // A local pending delete for this id means the user deleted it
        // locally and that delete hasn't reached the cloud yet (this pull
        // ran before the push, or the push failed) — don't let the stale
        // cloud row resurrect it locally; the pending delete will still be
        // retried and will remove it from the cloud on the next push.
        if (pendingDeleteIds.has(row.id)) continue;
        await saveItemLink({
          id: row.id,
          fromId: row.from_id,
          fromKind: row.from_kind,
          toId: row.to_id,
          toKind: row.to_kind,
          label: row.label || '',
          createdAt: row.created_at,
        }, { fromCloud: true });
      }

      for (const loc of localLinks) {
        if (cloudIds.has(loc.id)) continue; // present remotely — nothing to do here
        if (pendingCreateIds.has(loc.id)) continue; // created locally, not pushed yet — keep it
        // Not in the cloud snapshot and nothing pending locally: a
        // legitimate remote deletion (or a link this device never pushed
        // and never will). Safe to remove.
        await deleteItemLink(loc.id, { fromCloud: true });
      }
    }
  } catch (e) {
    console.warn('[sync] item_links pull skipped', e);
  }

  await setMeta('lastPullAt', Date.now());
}

// ── Image upload to Storage (idempotent via upsert) ───────────
export async function uploadImageToStorage(image, userId) {
  const supabase = getSupabase();
  if (!supabase) return image;
  if (!image.dataUrl) return image;

  const res = await fetch(image.dataUrl);
  const blob = await res.blob();
  const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const path = `${userId}/${image.id}.${ext}`;

  const { error } = await supabase.storage.from('prompt-images').upload(path, blob, {
    contentType: blob.type,
    upsert: true, // idempotent
  });
  if (error) throw error;

  const updated = {
    ...image,
    storage_path: path,
    updatedAt: image.updatedAt || Date.now(),
  };
  delete updated.dataUrl;
  // Persist without re-enqueueing
  await saveImage(updated, { fromCloud: true });
  return updated;
}

export async function getImagePublicUrl(storagePath) {
  const supabase = getSupabase();
  if (!supabase || !storagePath) return null;
  const { data } = await supabase.storage.from('prompt-images').createSignedUrl(storagePath, 3600);
  return data?.signedUrl || null;
}

// ── Full sync cycle ───────────────────────────────────────────
/**
 * fullSync — push pending, pull/merge, optional catch-up pull.
 * @param {string} userId
 * @param {{ catchUp?: boolean }} [opts]  When true, runs a second pull/merge
 *   after the first cycle so any cloud change that arrived while Realtime was
 *   still connecting (or during the first pull) is not missed.
 */
export async function fullSync(userId, opts = {}) {
  if (!CLOUD_ENABLED || !userId) {
    setStatus(isOnline() ? 'synced' : 'offline');
    return;
  }
  if (!isOnline()) {
    await refreshPendingCount();
    setStatus('offline');
    return;
  }
  if (syncInProgress) return;
  syncInProgress = true;
  currentUserId = userId;

  setStatus('syncing');
  try {
    // 1. Push local pending operations first
    await pushPending(userId);
    // 2. Pull + LWW merge
    await pullAndMerge(userId);
    // 3. Catch-up: final pull after Realtime is (or will be) subscribed
    //    so no cloud edit during bootstrap is silently missed.
    if (opts.catchUp) {
      await pullAndMerge(userId);
    }
    await refreshPendingCount();
    if (pendingCount > 0) {
      setStatus('syncing'); // still have failures
    } else {
      setStatus('synced');
    }
  } catch (err) {
    console.error('[sync] fullSync error', err);
    await refreshPendingCount();
    const msg = String(err?.message || err || '');
    const authFail = /jwt|session|not authenticated|invalid.*token|401|403/i.test(msg);
    if (authFail) {
      setStatus('error', 'Session expired or unauthorized. Sign in again to resume sync. Local changes are kept.');
    } else {
      setStatus('error', err.message || 'Unable to sync right now. Your changes are safely stored on this device and will retry automatically.');
    }
  } finally {
    syncInProgress = false;
  }
}

// ── Realtime ──────────────────────────────────────────────────
export function startRealtime(userId, onChange) {
  stopRealtime();
  const supabase = getSupabase();
  if (!supabase || !userId) return;
  onChangeCallback = onChange;
  currentUserId = userId;

  const applyRemote = async (entity, row, fromCloudFn, saveFn) => {
    const remote = fromCloudFn(row);
    let local = null;
    if (entity === 'folder') {
      const { getFolderAny } = await import('./db.js');
      local = await getFolderAny(remote.id);
    } else if (entity === 'prompt') {
      const { getPromptAny } = await import('./db.js');
      local = await getPromptAny(remote.id);
    }
    // Prefer cloud only if newer (or local missing) — never clobber a newer local edit
    if (!local || shouldPreferCloud(local, remote)) {
      await saveFn(remote, { fromCloud: true });
      onChangeCallback && onChangeCallback();
    }
  };

  const channel = supabase
    .channel('roys-sync-' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'folders', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') return; // we use soft-delete
        if (!payload.new) return;
        await applyRemote('folder', payload.new, fromCloudFolder, saveFolder);
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'prompts', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') return;
        if (!payload.new) return;
        await applyRemote('prompt', payload.new, fromCloudPrompt, savePrompt);
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'images', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') return;
        if (!payload.new) return;
        const remote = fromCloudImage(payload.new);
        // LWW: same rule as folders/prompts — never clobber a newer local image
        let local = null;
        try {
          const { getAllImagesRaw } = await import('./db.js');
          const all = await getAllImagesRaw();
          local = (all || []).find(i => i.id === remote.id) || null;
        } catch (_) {}
        if (!local || shouldPreferCloud(local, remote)) {
          const merged = { ...remote };
          // Preserve offline preview if remote has no binary
          if (local?.dataUrl && !merged.dataUrl) merged.dataUrl = local.dataUrl;
          await saveImage(merged, { fromCloud: true });
          onChangeCallback && onChangeCallback();
        }
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'library_items', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') return;
        if (!payload.new) return;
        const remote = fromCloudLibraryItem(payload.new);
        const { getLibraryItemAny } = await import('./db.js');
        const local = await getLibraryItemAny(remote.id);
        if (!local || shouldPreferCloud(local, remote)) {
          await saveLibraryItem(remote, { fromCloud: true });
          onChangeCallback && onChangeCallback();
        }
      })
    .subscribe();

  realtimeChannels.push(channel);
}

export function stopRealtime() {
  const supabase = getSupabase();
  realtimeChannels.forEach(ch => {
    try { supabase?.removeChannel(ch); } catch (_) {}
  });
  realtimeChannels = [];
}

// ── Network listeners (bound once) ────────────────────────────
export function initNetworkListeners(userId, onChange) {
  currentUserId = userId;
  onChangeCallback = onChange;

  if (networkListenersBound) {
    // Already bound — just refresh status
    if (!isOnline()) setStatus('offline');
    return;
  }
  networkListenersBound = true;

  window.addEventListener('online', async () => {
    if (currentUserId) {
      await fullSync(currentUserId);
      onChangeCallback && onChangeCallback();
    }
  });
  window.addEventListener('offline', async () => {
    await refreshPendingCount();
    setStatus('offline');
  });

  if (!isOnline()) setStatus('offline');
}

// ── Complete migration with progress ──────────────────────────
export async function migrateLocalToCloud(userId, onProgress) {
  const supabase = getSupabase();
  if (!supabase || !userId) throw new Error('Not signed in');

  setStatus('syncing');

  // Gather everything including we need images from IndexedDB
  const folders = await getAllFolders();
  const prompts = await getAllPrompts();

  // Load all images from store
  const { openDB } = await import('./db.js');
  await openDB();
  // Use raw getAll for images — export a helper
  let images = [];
  try {
    const dbMod = await import('./db.js');
    if (dbMod.getAllImagesRaw) {
      images = await dbMod.getAllImagesRaw();
    }
  } catch (_) {}

  const report = (phase, current, total) => {
    if (typeof onProgress === 'function') onProgress({ phase, current, total });
  };

  // Folders (idempotent upsert by id)
  report('Folders', 0, folders.length);
  if (folders.length) {
    const rows = folders.map(f => toCloudFolder(f, userId));
    // Upsert in batches of 50
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const { error } = await supabase.from('folders').upsert(batch);
      if (error) throw error;
      report('Folders', Math.min(i + 50, rows.length), rows.length);
    }
  } else {
    report('Folders', 0, 0);
  }

  // Prompts
  report('Prompts', 0, prompts.length);
  if (prompts.length) {
    const rows = prompts.map(p => toCloudPrompt(p, userId));
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const { error } = await supabase.from('prompts').upsert(batch);
      if (error) throw error;
      report('Prompts', Math.min(i + 50, rows.length), rows.length);
    }
  } else {
    report('Prompts', 0, 0);
  }

  // Images — upload binaries THEN metadata; both must succeed
  report('Images', 0, images.length);
  const imageFailures = [];
  for (let i = 0; i < images.length; i++) {
    let img = { ...images[i] };
    try {
      if (img.dataUrl && !img.storage_path) {
        img = await uploadImageToStorage(img, userId);
      }
      // Only write metadata if we have a storage_path OR no binary was required
      if (img.storage_path || !images[i].dataUrl) {
        const { error } = await supabase.from('images').upsert(toCloudImage(img, userId));
        if (error) throw error;
      } else {
        // Had dataUrl but upload did not produce storage_path
        throw new Error('Storage upload did not return path');
      }
    } catch (e) {
      console.error('[migrate] image failed', img.id, e);
      imageFailures.push({ id: img.id, error: e.message || String(e) });
    }
    report('Images', i + 1, images.length);
  }

  if (imageFailures.length) {
    // Do NOT mark migration complete — allow safe retry
    setStatus('error', `${imageFailures.length} image(s) failed to migrate. Retry migration.`);
    throw new Error(`${imageFailures.length} image(s) failed to migrate`);
  }

  // Only mark complete after folders, prompts, AND images all succeeded
  await setMeta('migratedToCloud', true);
  await setMeta('lastPullAt', Date.now());
  await refreshPendingCount();
  setStatus('synced');
}

// ── Cloud library existence (folders OR prompts OR images) ────
export async function cloudHasData(userId) {
  const supabase = getSupabase();
  if (!supabase) return false;

  const [f, p, i, l] = await Promise.all([
    supabase.from('folders').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('prompts').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('images').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('library_items').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ]);

  const count = (f.count || 0) + (p.count || 0) + (i.count || 0) + (l.count || 0);
  return count > 0;
}

// ── Optional sync_log (lightweight, no sensitive content) ─────
export async function logSyncEvent(userId, action, detail = {}) {
  const supabase = getSupabase();
  if (!supabase || !userId) return;
  try {
    await supabase.from('sync_log').insert({
      user_id: userId,
      entity_type: detail.entity || 'system',
      entity_id: detail.id || 'n/a',
      action,
      payload: { note: detail.note || null, at: Date.now() },
    });
  } catch (_) {
    // non-critical
  }
}
