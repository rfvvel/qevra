import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { HttpError } from '../shared/http-error.js';

let client: SupabaseClient | undefined;
export function getSupabaseAuth(): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured.');
  client ??= createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
