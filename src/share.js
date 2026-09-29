/**
 * Share system — create / revoke / list share links for prompts.
 * Uses snapshotted content so public never reads the prompts table.
 */
import { getSupabase, CLOUD_ENABLED } from './supabase.js';

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'sh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

/** Base URL for share links (current origin). */
export function shareBaseUrl() {
  return (typeof window !== 'undefined' ? window.location.origin : '') + '/share.html';
}

export function shareUrlForToken(token) {
  return shareBaseUrl() + '?t=' + encodeURIComponent(token);
}

/**
 * Create a share link for a prompt or library item the current user owns.
 * Snapshots title + content at creation time (public never reads live tables).
 * prompt_id column stores the source item id (prompt or library_item).
 */
/** Flatten library JSON types to readable plain text for public share pages. */
export function shareablePlainText(item) {
  const raw = item?.content;
  if (raw == null) return '';
  const s = String(raw);
  try {
    const data = JSON.parse(s);
    if (data && data.kind === 'document') return String(data.body || '');
    if (data && data.kind === 'presentation' && Array.isArray(data.slides)) {
      return data.slides.map((sl, i) => {
        const bullets = (sl.bullets || []).map((b) => `• ${b}`).join('\n');
        return `Slide ${i + 1}: ${sl.title || ''}\n${sl.body || ''}${bullets ? '\n' + bullets : ''}`;
      }).join('\n\n');
    }
    if (data && data.kind === 'spreadsheet' && Array.isArray(data.columns) && Array.isArray(data.rows)) {
      const lines = [data.columns.join('\t')];
      for (const r of data.rows) lines.push(data.columns.map((_, i) => r[i] ?? '').join('\t'));
      return lines.join('\n');
    }
  } catch (_) {}
  return s;
}

export async function createShareLink(userId, item) {
  if (!CLOUD_ENABLED) throw new Error('Cloud not configured — sign in with Supabase to share');
  const supabase = getSupabase();
  if (!supabase || !userId) throw new Error('Not signed in');
  if (!item?.id || !item?.title || item.content == null) throw new Error('Invalid item');

  const token = randomToken();
  const row = {
    id: uid(),
    token,
    user_id: userId,
    prompt_id: item.id,
    title: item.title,
    content: shareablePlainText(item),
    created_at: Date.now(),
    revoked_at: null,
  };

  const { error } = await supabase.from('shares').insert(row);
  if (error) throw error;

  return {
    id: row.id,
    token,
    url: shareUrlForToken(token),
    title: prompt.title,
  };
}

/** List active (non-revoked) shares for a prompt. */
export async function listSharesForPrompt(userId, promptId) {
  const supabase = getSupabase();
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from('shares')
    .select('id, token, title, created_at, revoked_at')
    .eq('user_id', userId)
    .eq('prompt_id', promptId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(s => ({
    ...s,
    url: shareUrlForToken(s.token),
  }));
}

/** Revoke a share by id (owner only via RLS). */
export async function revokeShare(userId, shareId) {
  const supabase = getSupabase();
  if (!supabase || !userId) throw new Error('Not signed in');
  const { error } = await supabase
    .from('shares')
    .update({ revoked_at: Date.now() })
    .eq('id', shareId)
    .eq('user_id', userId);
  if (error) throw error;
}

/** List all active share links for the signed-in user (any item type). */
export async function listAllShares(userId) {
  const supabase = getSupabase();
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from('shares')
    .select('id, token, title, prompt_id, created_at, revoked_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(s => ({
    ...s,
    url: shareUrlForToken(s.token),
  }));
}

/**
 * Public: load share by token (no auth required).
 * Uses security-definer RPC — does not expose other shares.
 */
export async function fetchPublicShare(token) {
  if (!token) return null;
  const supabase = getSupabase();
  if (!supabase) throw new Error('Cloud not configured');
  const { data, error } = await supabase.rpc('get_public_share', { p_token: token });
  if (error) throw error;
  if (!data || !data.length) return null;
  return data[0];
}
