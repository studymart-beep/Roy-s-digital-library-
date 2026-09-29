/**
 * Roy's Digital Library — Local IndexedDB cache + pending queue
 * Source of truth when offline; cloud is source of truth when online.
 */

const DB_NAME = 'roys-prompt-library';
const DB_VERSION = 4;

let db = null;

export async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('folders')) {
        const folders = database.createObjectStore('folders', { keyPath: 'id' });
        folders.createIndex('parentId', 'parentId', { unique: false });
      }
      if (!database.objectStoreNames.contains('prompts')) {
        const prompts = database.createObjectStore('prompts', { keyPath: 'id' });
        prompts.createIndex('folderId', 'folderId', { unique: false });
        prompts.createIndex('isFavorite', 'isFavorite', { unique: false });
        prompts.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains('images')) {
        const images = database.createObjectStore('images', { keyPath: 'id' });
        images.createIndex('parentId', 'parentId', { unique: false });
      }
      if (!database.objectStoreNames.contains('pending')) {
        database.createObjectStore('pending', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('library_items')) {
        const li = database.createObjectStore('library_items', { keyPath: 'id' });
        li.createIndex('folderId', 'folderId', { unique: false });
        li.createIndex('itemType', 'itemType', { unique: false });
        li.createIndex('isFavorite', 'isFavorite', { unique: false });
        li.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains('item_links')) {
        const links = database.createObjectStore('item_links', { keyPath: 'id' });
        links.createIndex('fromId', 'fromId', { unique: false });
        links.createIndex('toId', 'toId', { unique: false });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

async function getAll(storeName) {
  await openDB();
  return new Promise((res, rej) => {
    const r = store(storeName).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

async function getOne(storeName, id) {
  await openDB();
  return new Promise((res, rej) => {
    const r = store(storeName).get(id);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function put(storeName, item) {
  await openDB();
  return new Promise((res, rej) => {
    const r = store(storeName, 'readwrite').put(item);
    r.onsuccess = () => res(item);
    r.onerror = () => rej(r.error);
  });
}

async function remove(storeName, id) {
  await openDB();
  return new Promise((res, rej) => {
    const r = store(storeName, 'readwrite').delete(id);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

export async function getAllFolders() {
  const all = await getAll('folders');
  return all.filter(f => !f.deletedAt);
}

export async function getFolder(id) {
  const f = await getOne('folders', id);
  return f && !f.deletedAt ? f : null;
}

/** Return folder even if soft-deleted (for merge/conflict). */
export async function getFolderAny(id) {
  return getOne('folders', id);
}

export async function getPromptAny(id) {
  return getOne('prompts', id);
}

export async function saveFolder(folder, { fromCloud = false } = {}) {
  // Local mutations always get a fresh timestamp; cloud applies remote updatedAt.
  if (!fromCloud) folder.updatedAt = Date.now();
  else folder.updatedAt = folder.updatedAt || Date.now();
  await put('folders', folder);
  if (!fromCloud) await enqueue('folder', 'upsert', folder);
  return folder;
}

export async function deleteFolder(id, { soft = true, fromCloud = false } = {}) {
  if (soft) {
    const f = await getOne('folders', id);
    if (f) {
      f.deletedAt = Date.now();
      f.updatedAt = Date.now();
      await put('folders', f);
      if (!fromCloud) await enqueue('folder', 'delete', { id, deletedAt: f.deletedAt });
    }
  } else {
    await remove('folders', id);
  }
}

/**
 * Soft-delete a folder, every folder nested inside it, and every prompt AND
 * library item (research/strategy/idea/note/resource/template/experiment/
 * product_asset) they contain.
 *
 * v3.9 fix: this used to only cascade to `prompts`, leaving `library_items`
 * inside a deleted folder still visible (orphaned pointers to a folder that
 * no longer "exists" from the user's perspective) even though the MCP
 * server's delete_folder tool (mcp-server/lib/tools.mjs) already cascaded
 * to both tables. This now matches that same cascade semantics so the app
 * and the MCP server agree on what "delete a folder" means, and each
 * affected library item is enqueued for push just like folders/prompts so
 * the deletion actually reaches the cloud on next sync.
 */
export async function softDeleteFolderCascade(id) {
  const allFolders = await getAll('folders');
  const toDelete = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of allFolders) {
      if (toDelete.has(f.parentId) && !toDelete.has(f.id)) {
        toDelete.add(f.id);
        changed = true;
      }
    }
  }
  const now = Date.now();
  for (const fid of toDelete) {
    const f = await getOne('folders', fid);
    if (f && !f.deletedAt) {
      f.deletedAt = now;
      f.updatedAt = now;
      await put('folders', f);
      await enqueue('folder', 'delete', { id: fid, deletedAt: now });
    }
  }
  const prompts = await getAll('prompts');
  for (const p of prompts) {
    if (toDelete.has(p.folderId) && !p.deletedAt) {
      p.deletedAt = now;
      p.updatedAt = now;
      await put('prompts', p);
      await enqueue('prompt', 'delete', { id: p.id, deletedAt: now });
    }
  }
  const libraryItems = await getAll('library_items');
  for (const li of libraryItems) {
    if (toDelete.has(li.folderId) && !li.deletedAt) {
      li.deletedAt = now;
      li.updatedAt = now;
      await put('library_items', li);
      await enqueue('library_item', 'delete', { id: li.id, deletedAt: now });
    }
  }
}

export async function getAllPrompts() {
  const all = await getAll('prompts');
  return all.filter(p => !p.deletedAt);
}

export async function getPrompt(id) {
  const p = await getOne('prompts', id);
  return p && !p.deletedAt ? p : null;
}

export async function getPromptsByFolder(folderId) {
  const all = await getAllPrompts();
  return all.filter(p => p.folderId === folderId);
}

export async function getFavorites() {
  const all = await getAllPrompts();
  return all.filter(p => p.isFavorite);
}

export async function getDeletedPrompts() {
  const all = await getAll('prompts');
  return all.filter(p => p.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function savePrompt(prompt, { fromCloud = false } = {}) {
  if (!fromCloud) prompt.updatedAt = Date.now();
  else prompt.updatedAt = prompt.updatedAt || Date.now();
  await put('prompts', prompt);
  if (!fromCloud) await enqueue('prompt', 'upsert', prompt);
  return prompt;
}

export async function deletePrompt(id, { soft = true, fromCloud = false } = {}) {
  if (soft) {
    const p = await getOne('prompts', id);
    if (p) {
      p.deletedAt = Date.now();
      p.updatedAt = Date.now();
      await put('prompts', p);
      if (!fromCloud) await enqueue('prompt', 'delete', { id, deletedAt: p.deletedAt });
    }
  } else {
    await remove('prompts', id);
  }
}

export async function restorePrompt(id) {
  const p = await getOne('prompts', id);
  if (p) {
    delete p.deletedAt;
    p.updatedAt = Date.now();
    await put('prompts', p);
    await enqueue('prompt', 'upsert', p);
  }
}

export async function getAllImagesRaw() {
  return getAll('images');
}

export async function getImagesByParent(parentId) {
  const all = await getAll('images');
  return all.filter(i => i.parentId === parentId && !i.deletedAt);
}

export async function saveImage(image, { fromCloud = false } = {}) {
  if (!fromCloud) image.updatedAt = Date.now();
  else image.updatedAt = image.updatedAt || Date.now();
  await put('images', image);
  if (!fromCloud) await enqueue('image', 'upsert', image);
  return image;
}

export async function deleteImage(id, { soft = true, fromCloud = false } = {}) {
  if (soft) {
    const img = await getOne('images', id);
    if (img) {
      img.deletedAt = Date.now();
      img.updatedAt = Date.now();
      await put('images', img);
      if (!fromCloud) await enqueue('image', 'delete', { id, deletedAt: img.deletedAt });
    }
  } else {
    await remove('images', id);
  }
}


// ── Library items (research, strategy, notes, …) ──────────────
export async function getAllLibraryItems() {
  const all = await getAll('library_items');
  return all.filter(i => !i.deletedAt);
}

export async function getDeletedLibraryItems() {
  const all = await getAll('library_items');
  return all.filter(i => i.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function getLibraryItem(id) {
  const i = await getOne('library_items', id);
  return i && !i.deletedAt ? i : null;
}

export async function getLibraryItemAny(id) {
  return getOne('library_items', id);
}

export async function getLibraryItemsByFolder(folderId) {
  const all = await getAllLibraryItems();
  return all.filter(i => i.folderId === folderId);
}

export async function saveLibraryItem(item, { fromCloud = false } = {}) {
  if (!fromCloud) item.updatedAt = Date.now();
  else item.updatedAt = item.updatedAt || Date.now();
  if (!item.itemType) item.itemType = 'note';
  if (!item.tags) item.tags = [];
  if (item.notes == null) item.notes = '';
  if (item.sourceUrl == null) item.sourceUrl = '';
  if (item.isFavorite == null) item.isFavorite = false;
  await put('library_items', item);
  if (!fromCloud) await enqueue('library_item', 'upsert', item);
  return item;
}

export async function deleteLibraryItem(id, { soft = true, fromCloud = false } = {}) {
  if (soft) {
    const i = await getOne('library_items', id);
    if (i) {
      i.deletedAt = Date.now();
      i.updatedAt = Date.now();
      await put('library_items', i);
      if (!fromCloud) await enqueue('library_item', 'delete', { id, deletedAt: i.deletedAt });
    }
  } else {
    await remove('library_items', id);
  }
}

export async function restoreLibraryItem(id) {
  const i = await getOne('library_items', id);
  if (i) {
    delete i.deletedAt;
    i.updatedAt = Date.now();
    await put('library_items', i);
    await enqueue('library_item', 'upsert', i);
  }
}


// ── Item links (related items) ────────────────────────────────
export async function getAllItemLinks() {
  return getAll('item_links');
}

export async function getLinksForItem(itemId) {
  const all = await getAll('item_links');
  return all.filter(l => l.fromId === itemId || l.toId === itemId);
}

export async function saveItemLink(link, { fromCloud = false } = {}) {
  await put('item_links', link);
  if (!fromCloud) await enqueue('item_link', 'upsert', link);
  return link;
}

export async function deleteItemLink(id, { fromCloud = false } = {}) {
  await remove('item_links', id);
  if (!fromCloud) await enqueue('item_link', 'delete', { id });
}

export async function enqueue(entity, action, payload) {
  await openDB();
  const item = {
    id: entity + '-' + (payload.id || 'x') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    entity,
    action,
    payload,
    createdAt: Date.now(),
  };
  await put('pending', item);
  return item;
}

export async function getPending() {
  return getAll('pending');
}

export async function clearPending(id) {
  await remove('pending', id);
}

export async function clearAllPending() {
  await openDB();
  return new Promise((res, rej) => {
    const r = store('pending', 'readwrite').clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

/**
 * Wipe all local library data for account switch.
 * Cloud remains source of truth — next sign-in pulls that user's data only.
 * Does not delete the IndexedDB database itself (keeps connection stable).
 */
export async function clearLocalUserData() {
  await openDB();
  const names = ['folders', 'prompts', 'images', 'library_items', 'item_links', 'pending', 'meta'];
  const existing = names.filter((n) => db.objectStoreNames.contains(n));
  if (!existing.length) return;
  await new Promise((resolve, reject) => {
    const t = db.transaction(existing, 'readwrite');
    for (const n of existing) t.objectStore(n).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getMeta(key) {
  const item = await getOne('meta', key);
  return item ? item.value : null;
}

export async function setMeta(key, value) {
  await put('meta', { key, value });
}

export async function replaceAllLocal({ folders = [], prompts = [], images = [] }) {
  await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['folders', 'prompts', 'images'], 'readwrite');
    t.objectStore('folders').clear();
    t.objectStore('prompts').clear();
    t.objectStore('images').clear();
    for (const f of folders) t.objectStore('folders').put(f);
    for (const p of prompts) t.objectStore('prompts').put(p);
    for (const i of images) t.objectStore('images').put(i);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function exportAll() {
  const folders = await getAll('folders');
  const prompts = await getAll('prompts');
  const images = await getAll('images');
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    folders,
    prompts,
    images: images.map(img => {
      const copy = { ...img };
      if (copy.storage_path && copy.dataUrl) delete copy.dataUrl;
      return copy;
    }),
  };
}

export async function importAll(data) {
  await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['folders', 'prompts', 'images'], 'readwrite');
    t.objectStore('folders').clear();
    t.objectStore('prompts').clear();
    t.objectStore('images').clear();
    for (const f of data.folders || []) t.objectStore('folders').put(f);
    for (const p of data.prompts || []) t.objectStore('prompts').put(p);
    for (const i of data.images || []) t.objectStore('images').put(i);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function seedIfEmpty() {
  const folders = await getAllFolders();
  if (folders.length > 0) return false;

  const now = Date.now();
  const rootId = 'root';
  const structure = [
    { id: rootId, name: "Roy's Digital Library", parentId: null, createdAt: now, updatedAt: now },
    { id: 'outreach', name: 'Outreach', parentId: rootId, createdAt: now, updatedAt: now },
    { id: 'cold', name: 'Cold Outreach', parentId: 'outreach', createdAt: now, updatedAt: now },
    { id: 'followup', name: 'Follow-Up', parentId: 'outreach', createdAt: now, updatedAt: now },
    { id: 'welcome', name: 'Welcome Messages', parentId: 'outreach', createdAt: now, updatedAt: now },
    { id: 'content', name: 'Content', parentId: rootId, createdAt: now, updatedAt: now },
    { id: 'ugc', name: 'UGC', parentId: 'content', createdAt: now, updatedAt: now },
    { id: 'captions', name: 'Captions', parentId: 'content', createdAt: now, updatedAt: now },
    { id: 'product-desc', name: 'Product Descriptions', parentId: 'content', createdAt: now, updatedAt: now },
    { id: 'sales', name: 'Sales', parentId: rootId, createdAt: now, updatedAt: now },
    { id: 'objections', name: 'Objection Handling', parentId: 'sales', createdAt: now, updatedAt: now },
    { id: 'closing', name: 'Closing', parentId: 'sales', createdAt: now, updatedAt: now },
    { id: 'images', name: 'Images', parentId: rootId, createdAt: now, updatedAt: now },
    { id: 'product-images', name: 'Product Images', parentId: 'images', createdAt: now, updatedAt: now },
    { id: 'ugc-images', name: 'UGC Images', parentId: 'images', createdAt: now, updatedAt: now },
    { id: 'inspiration', name: 'Inspiration', parentId: 'images', createdAt: now, updatedAt: now },
  ];
  for (const f of structure) await put('folders', f);

  const samples = [
    {
      id: 'p1', folderId: 'cold', title: 'Cold Outreach — Short',
      content: 'Hey {{name}},\n\nI noticed you\'re building {{product}}. I\'ve helped similar founders cut onboarding time by ~40%.\n\nWould you be open to a quick 10-min chat this week?\n\nBest,\nRoy',
      tags: ['outreach', 'sales'], notes: '', isFavorite: true, createdAt: now, updatedAt: now,
    },
    {
      id: 'p2', folderId: 'followup', title: 'Follow-Up — Day 3',
      content: 'Hey {{name}}, just bumping this in case it got buried.\n\nStill happy to share the short playbook if useful — no pitch, just value.\n\nLet me know either way.',
      tags: ['outreach', 'follow-up'], notes: '', isFavorite: false, createdAt: now, updatedAt: now,
    },
    {
      id: 'p3', folderId: 'ugc', title: 'UGC Hook Generator',
      content: 'You are an expert UGC scriptwriter.\n\nProduct: {{product}}\nAudience: {{audience}}\nTone: {{tone}}\n\nGenerate 5 scroll-stopping hooks (max 12 words each) that create curiosity or highlight a painful problem the product solves.',
      tags: ['ugc', 'content'], notes: 'Use with ChatGPT or Claude', isFavorite: true, createdAt: now, updatedAt: now,
    },
    {
      id: 'p4', folderId: 'objections', title: 'Price Objection',
      content: 'I completely understand budget is a concern.\n\nMost clients who felt the same way found that the ROI in the first 30 days more than covered the investment because of {{specific benefit}}.\n\nWould it help if I walked you through a simple breakdown of expected results?',
      tags: ['sales', 'objections'], notes: '', isFavorite: false, createdAt: now, updatedAt: now,
    },
  ];
  for (const p of samples) await put('prompts', p);
  return true;
}
