/**
 * Supabase-backed OAuth store for free Render (no persistent disk).
 * Requires SUPABASE_SERVICE_ROLE_KEY + table public.mcp_oauth_kv
 * Falls back: caller should use file store if this is unavailable.
 */
import { createClient } from '@supabase/supabase-js';

const TABLE = 'mcp_oauth_kv';
const ROW_ID = 'default';

export function canUseSupabaseStore() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function admin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function loadSupabaseStoreRaw() {
  const sb = admin();
  const { data, error } = await sb.from(TABLE).select('payload').eq('id', ROW_ID).maybeSingle();
  if (error) throw error;
  return data?.payload || null;
}

export async function saveSupabaseStoreRaw(payloadObj) {
  const sb = admin();
  const { error } = await sb.from(TABLE).upsert({
    id: ROW_ID,
    payload: payloadObj,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
