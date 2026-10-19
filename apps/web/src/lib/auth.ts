import { staffCredentialsSchema, type StaffCredentials } from '@qevra/contracts';
import type { Session } from '@supabase/supabase-js';
import { getSupabase, getCustomerSupabase } from './supabase';

export async function signInStaff(credentials: StaffCredentials): Promise<Session> {
  const { data, error } = await getSupabase().auth.signInWithPassword(staffCredentialsSchema.parse(credentials));
  if (error) throw error;
  return data.session;
}

let pendingSession: Promise<Session> | undefined;
export function ensureCustomerSession(): Promise<Session> {
  pendingSession ??= (async()=>{
    if(navigator.locks)return await navigator.locks.request('qevra-customer-start',getOrCreateSession);
    return getOrCreateSession();
  })().finally(()=>{pendingSession=undefined;});
  return pendingSession;
}
async function getOrCreateSession(): Promise<Session> {
  const client=getCustomerSupabase();
  const existing=await client.auth.getSession();
  if(existing.error)throw existing.error;
  if(existing.data.session?.user.is_anonymous)return existing.data.session;
  if(existing.data.session)throw new Error('Customer access is unavailable.');
  // Preserve anonymous identities established by the earlier foundation.
  const legacy=await getSupabase().auth.getSession();
  if(legacy.data.session?.user.is_anonymous){
    const restored=await client.auth.setSession({access_token:legacy.data.session.access_token,refresh_token:legacy.data.session.refresh_token});
    if(restored.error)throw restored.error;
    if(restored.data.session)return restored.data.session;
  }
  const {data,error}=await client.auth.signInAnonymously();
  if(error)throw error;
  if(!data.session)throw new Error('Unable to get ready.');
  return data.session;
}
export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut({ scope: 'local' });
  if (error) throw error;
}
