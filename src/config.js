/**
 * Roy's Digital Library — Configuration
 *
 * Never put the service_role key here — only the anon key.
 */

export const SUPABASE_URL = 'https://koqahvdarauyhehsokqw.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtvcWFodmRhcmF1eWhlaHNva3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MDkzNzEsImV4cCI6MjEwNTk4NTM3MX0.Mw7ZiMq5yKxFc2ZWSOEzEuqiranbb1vwg8ilWwBtH9E';

// Enabled when real URL + anon key are present
export const CLOUD_ENABLED =
  SUPABASE_URL !== 'YOUR_SUPABASE_URL' &&
  SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY' &&
  SUPABASE_URL.startsWith('https://') &&
  SUPABASE_ANON_KEY.startsWith('eyJ');

// Hosted MCP (Render) — used by Settings UI and client docs
export const MCP_HOSTED_URL = 'https://roys-s-digital-library-mcp.onrender.com';
export const MCP_ENDPOINT = MCP_HOSTED_URL + '/mcp';

