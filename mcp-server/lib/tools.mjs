/**
 * Shared MCP tool business logic — identity from verified JWT only.
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes, createHash } from 'crypto';

const ITEM_TYPES = new Set([
  'prompt', 'research', 'strategy', 'idea', 'note',
  'resource', 'template', 'experiment', 'product_asset',
]);

export const TOOL_SCOPES = {
  search_library: 'library:read',
  get_library_item: 'library:read',
  list_folders: 'library:read',
  get_related_items: 'library:read',
  create_library_item: 'library:write',
  update_library_item: 'library:write',
  move_library_item: 'library:write',
  create_folder: 'library:write',
  create_share_link: 'library:share',
  revoke_share_link: 'library:share',
  restore_library_item: 'library:write',
  delete_library_item: 'library:delete',
  delete_folder: 'library:delete',
};

export function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function clientForToken(url, anon, accessToken) {
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function resolveUser(sb, accessToken) {
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user?.id) throw makeError('UNAUTHORIZED', 'Invalid or expired access token');
  return data.user;
}

export async function getUserEntitlement(userId) {
  return {
    plan: process.env.DEFAULT_PLAN || 'free',
    status: 'active',
    scopes: {
      'library:read': true,
      'library:write': true,
      'library:delete': true,
      'library:share': true,
    },
  };
}

export function assertScope(entitlement, scope) {
  if (!entitlement?.scopes?.[scope]) throw makeError('FORBIDDEN', `Missing scope: ${scope}`);
}

function validateString(v, name, { min = 1, max = 20000, required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw makeError('VALIDATION_ERROR', `${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw makeError('VALIDATION_ERROR', `${name} must be a string`);
  const s = v.trim();
  if (s.length < min) throw makeError('VALIDATION_ERROR', `${name} too short`);
  if (s.length > max) throw makeError('VALIDATION_ERROR', `${name} too long`);
  return s;
}

function uid() {
  return randomBytes(16).toString('hex');
}

function shareToken() {
  return randomBytes(24).toString('hex');
}

export async function runTool(name, args, ctx) {
  const { sb, user, entitlement } = ctx;
  const scope = TOOL_SCOPES[name];
  if (!scope) throw makeError('NOT_FOUND', `Unknown tool: ${name}`);
  assertScope(entitlement, scope);
  const a = { ...(args || {}) };
  delete a.user_id;
  delete a.userId;
  delete a.access_token;
  const userId = user.id;

  switch (name) {
    case 'search_library': {
      // Filtering happens in Postgres (ilike on title/content, exact match
      // on tags) rather than fetching a fixed page and filtering in JS, so
      // results beyond the first ~100 rows are no longer silently dropped.
      // Pagination is a real offset/limit pair against the database.
      const qRaw = (a.query || '').trim();
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
      const offset = Math.max(Number(a.offset) || 0, 0);
      const type = a.item_type;
      const folderId = a.folder_id;
      const tagFilter = a.tag ? String(a.tag) : null;
      const escLike = (s) => s.replace(/[%_]/g, (m) => `\\${m}`);
      const like = qRaw ? `%${escLike(qRaw)}%` : null;

      const results = [];
      let totalCount = 0;

      if (!type || type === 'prompt') {
        let query = sb.from('prompts')
          .select('id, title, content, tags, folder_id, updated_at', { count: 'exact' })
          .eq('user_id', userId).is('deleted_at', null);
        if (folderId) query = query.eq('folder_id', folderId);
        if (tagFilter) query = query.contains('tags', [tagFilter]);
        if (like) query = query.or(`title.ilike.${like},content.ilike.${like}`);
        const { data, error, count } = await query
          .order('updated_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (error) throw makeError('DEPENDENCY_ERROR', error.message);
        totalCount += count || 0;
        for (const row of data || []) {
          results.push({
            kind: 'prompt', id: row.id, title: row.title,
            snippet: (row.content || '').slice(0, 200), tags: row.tags || [],
            folder_id: row.folder_id, updated_at: row.updated_at,
          });
        }
      }
      if (!type || type !== 'prompt') {
        let query = sb.from('library_items')
          .select('id, title, content, tags, folder_id, item_type, updated_at', { count: 'exact' })
          .eq('user_id', userId).is('deleted_at', null);
        if (type && type !== 'prompt') query = query.eq('item_type', type);
        if (folderId) query = query.eq('folder_id', folderId);
        if (tagFilter) query = query.contains('tags', [tagFilter]);
        if (like) query = query.or(`title.ilike.${like},content.ilike.${like}`);
        const { data, error, count } = await query
          .order('updated_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (error && !String(error.message).includes('does not exist')) throw makeError('DEPENDENCY_ERROR', error.message);
        totalCount += count || 0;
        for (const row of data || []) {
          results.push({
            kind: 'library_item', item_type: row.item_type, id: row.id, title: row.title,
            snippet: (row.content || '').slice(0, 200), tags: row.tags || [],
            folder_id: row.folder_id, updated_at: row.updated_at,
          });
        }
      }
      results.sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0));
      const page = results.slice(0, limit);
      return {
        count: page.length,
        total: totalCount,
        offset,
        has_more: offset + page.length < totalCount,
        items: page,
      };
    }
    case 'get_library_item': {
      const id = validateString(a.id, 'id');
      if (!a.kind || a.kind === 'prompt') {
        const { data, error } = await sb.from('prompts').select('id, title, content, tags, notes, folder_id, is_favorite, updated_at')
          .eq('id', id).eq('user_id', userId).is('deleted_at', null).maybeSingle();
        if (error) throw makeError('DEPENDENCY_ERROR', error.message);
        if (data) return { kind: 'prompt', ...data, is_favorite: !!data.is_favorite };
        if (a.kind === 'prompt') throw makeError('NOT_FOUND', 'Not found');
      }
      const { data, error } = await sb.from('library_items').select('id, title, content, tags, notes, source_url, folder_id, item_type, is_favorite, updated_at')
        .eq('id', id).eq('user_id', userId).is('deleted_at', null).maybeSingle();
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      if (!data) throw makeError('NOT_FOUND', 'Not found');
      return { kind: 'library_item', ...data, is_favorite: !!data.is_favorite };
    }
    case 'list_folders': {
      const { data, error } = await sb.from('folders').select('id, name, parent_id, updated_at')
        .eq('user_id', userId).is('deleted_at', null).order('name');
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      return { folders: data || [] };
    }
    case 'get_related_items': {
      const id = validateString(a.id, 'id');
      const { data, error } = await sb.from('item_links').select('id, from_id, from_kind, to_id, to_kind, label')
        .eq('user_id', userId).or(`from_id.eq.${id},to_id.eq.${id}`);
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      return { links: data || [] };
    }
    case 'create_library_item': {
      const title = validateString(a.title, 'title', { max: 500 });
      const content = validateString(a.content, 'content', { max: 100000 });
      const itemType = validateString(a.item_type, 'item_type', { max: 40 });
      if (!ITEM_TYPES.has(itemType)) throw makeError('VALIDATION_ERROR', 'Invalid item_type');
      const folderId = a.folder_id ? validateString(a.folder_id, 'folder_id', { max: 80 }) : 'root';
      const tags = Array.isArray(a.tags) ? a.tags.map(String).slice(0, 30) : [];
      const now = Date.now();
      const id = a.idempotency_key
        ? createHash('sha256').update(userId + ':' + a.idempotency_key).digest('hex').slice(0, 32)
        : uid();
      if (itemType === 'prompt') {
        const { error } = await sb.from('prompts').upsert({
          id, user_id: userId, folder_id: folderId, title, content, tags,
          notes: a.notes || '', is_favorite: false, created_at: now, updated_at: now, deleted_at: null,
        });
        if (error) throw makeError('DEPENDENCY_ERROR', error.message);
        return { kind: 'prompt', id, title, folder_id: folderId };
      }
      const { error } = await sb.from('library_items').upsert({
        id, user_id: userId, folder_id: folderId, item_type: itemType, title, content, tags,
        notes: a.notes || '', source_url: a.source_url || '', metadata: {},
        is_favorite: false, created_at: now, updated_at: now, deleted_at: null,
      });
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      return { kind: 'library_item', item_type: itemType, id, title, folder_id: folderId };
    }
    case 'update_library_item': {
      const id = validateString(a.id, 'id');
      const kind = a.kind || 'library_item';
      const patch = { updated_at: Date.now() };
      if (a.title != null) patch.title = validateString(a.title, 'title', { max: 500 });
      if (a.content != null) patch.content = validateString(a.content, 'content', { max: 100000, required: false });
      if (a.tags != null) patch.tags = Array.isArray(a.tags) ? a.tags.map(String).slice(0, 30) : [];
      if (a.notes != null) patch.notes = String(a.notes);
      if (a.is_favorite != null) patch.is_favorite = !!a.is_favorite;
      const table = kind === 'prompt' ? 'prompts' : 'library_items';
      const { data, error } = await sb.from(table).update(patch).eq('id', id).eq('user_id', userId).select('id, title').maybeSingle();
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      if (!data) throw makeError('NOT_FOUND', 'Not found or permission denied');
      return { updated: true, id: data.id, title: data.title, kind };
    }
    case 'move_library_item': {
      const id = validateString(a.id, 'id');
      const folderId = validateString(a.folder_id, 'folder_id');
      const kind = a.kind || 'library_item';
      const table = kind === 'prompt' ? 'prompts' : 'library_items';
      const { data, error } = await sb.from(table).update({ folder_id: folderId, updated_at: Date.now() })
        .eq('id', id).eq('user_id', userId).select('id, folder_id').maybeSingle();
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      if (!data) throw makeError('NOT_FOUND', 'Not found or permission denied');
      return { moved: true, id: data.id, folder_id: data.folder_id, kind };
    }
    case 'create_folder': {
      const name = validateString(a.name, 'name', { max: 200 });
      const parentId = a.parent_id ? validateString(a.parent_id, 'parent_id', { max: 80 }) : 'root';
      const now = Date.now();
      const id = a.idempotency_key
        ? createHash('sha256').update(userId + ':folder:' + a.idempotency_key).digest('hex').slice(0, 32)
        : uid();
      const { error } = await sb.from('folders').upsert({
        id, user_id: userId, name, parent_id: parentId === 'root' ? 'root' : parentId,
        created_at: now, updated_at: now, deleted_at: null,
      });
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      return { id, name, parent_id: parentId };
    }
    case 'create_share_link': {
      const promptId = validateString(a.prompt_id, 'prompt_id');
      const { data: prompt, error: pErr } = await sb.from('prompts').select('id, title, content')
        .eq('id', promptId).eq('user_id', userId).is('deleted_at', null).maybeSingle();
      if (pErr) throw makeError('DEPENDENCY_ERROR', pErr.message);
      if (!prompt) throw makeError('NOT_FOUND', 'Prompt not found');
      const token = shareToken();
      const id = uid();
      const { error } = await sb.from('shares').insert({
        id, token, user_id: userId, prompt_id: prompt.id, title: prompt.title,
        content: prompt.content, created_at: Date.now(), revoked_at: null,
      });
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      return { share_token: token, path: `/share.html?t=${token}`, title: prompt.title };
    }
    case 'revoke_share_link': {
      // Accept either the share id or the public token so callers don't
      // need to have kept the id around after create_share_link returned
      // only the token.
      const shareId = a.id ? validateString(a.id, 'id', { required: false }) : null;
      const shareToken = a.share_token ? validateString(a.share_token, 'share_token', { required: false }) : null;
      if (!shareId && !shareToken) throw makeError('VALIDATION_ERROR', 'id or share_token is required');
      let query = sb.from('shares').update({ revoked_at: Date.now() }).eq('user_id', userId).is('revoked_at', null);
      query = shareId ? query.eq('id', shareId) : query.eq('token', shareToken);
      const { data, error } = await query.select('id').maybeSingle();
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      if (!data) throw makeError('NOT_FOUND', 'Share not found, already revoked, or not owned by you');
      return { revoked: true, id: data.id };
    }
    case 'restore_library_item': {
      const id = validateString(a.id, 'id');
      const kind = a.kind || 'library_item';
      const table = kind === 'prompt' ? 'prompts' : 'library_items';
      const now = Date.now();
      const { data, error } = await sb.from(table)
        .update({ deleted_at: null, updated_at: now })
        .eq('id', id).eq('user_id', userId)
        .select('id, title').maybeSingle();
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      if (!data) throw makeError('NOT_FOUND', 'Not found or permission denied');
      return { restored: true, id: data.id, title: data.title, kind };
    }
    case 'delete_folder': {
      // Cascading soft-delete: the folder, every descendant folder, and
      // every prompt / library item inside any of them. Requires confirm
      // just like delete_library_item, since it can affect many records
      // at once.
      if (a.confirm !== true) throw makeError('VALIDATION_ERROR', 'confirm must be true to delete a folder');
      const rootId = validateString(a.id, 'id');
      const { data: folders, error: fErr } = await sb.from('folders')
        .select('id, parent_id').eq('user_id', userId).is('deleted_at', null);
      if (fErr) throw makeError('DEPENDENCY_ERROR', fErr.message);
      const toDelete = new Set([rootId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const f of folders || []) {
          if (toDelete.has(f.parent_id) && !toDelete.has(f.id)) {
            toDelete.add(f.id);
            changed = true;
          }
        }
      }
      const ids = [...toDelete];
      const now = Date.now();
      const { error: dfErr } = await sb.from('folders')
        .update({ deleted_at: now, updated_at: now })
        .in('id', ids).eq('user_id', userId);
      if (dfErr) throw makeError('DEPENDENCY_ERROR', dfErr.message);
      const { error: dpErr } = await sb.from('prompts')
        .update({ deleted_at: now, updated_at: now })
        .in('folder_id', ids).eq('user_id', userId).is('deleted_at', null);
      if (dpErr) throw makeError('DEPENDENCY_ERROR', dpErr.message);
      const { error: dlErr } = await sb.from('library_items')
        .update({ deleted_at: now, updated_at: now })
        .in('folder_id', ids).eq('user_id', userId).is('deleted_at', null);
      if (dlErr && !String(dlErr.message).includes('does not exist')) throw makeError('DEPENDENCY_ERROR', dlErr.message);
      return { deleted: true, folder_ids: ids, soft: true };
    }
    case 'delete_library_item': {
      if (a.confirm !== true) throw makeError('VALIDATION_ERROR', 'confirm must be true to delete');
      const id = validateString(a.id, 'id');
      const kind = a.kind || 'library_item';
      const table = kind === 'prompt' ? 'prompts' : 'library_items';
      const now = Date.now();
      const { data, error } = await sb.from(table).update({ deleted_at: now, updated_at: now })
        .eq('id', id).eq('user_id', userId).select('id').maybeSingle();
      if (error) throw makeError('DEPENDENCY_ERROR', error.message);
      if (!data) throw makeError('NOT_FOUND', 'Not found or permission denied');
      return { deleted: true, id, soft: true, kind };
    }
    default:
      throw makeError('NOT_FOUND', `Unknown tool: ${name}`);
  }
}
