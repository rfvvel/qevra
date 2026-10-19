import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;
export function getSupabase(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Set the public Supabase environment variables before using authentication.');
  client ??= createClient(url, key);
  return client;
}

let customerClient: SupabaseClient | undefined;
export function getCustomerSupabase(): SupabaseClient {
  const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if(!url||!key)throw new Error('Customer access is unavailable.');
  customerClient??=createClient(url,key,{auth:{storageKey:'qevra-customer-'+new URL(url).hostname,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  return customerClient;
}
