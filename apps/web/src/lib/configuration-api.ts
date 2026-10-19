import { getSupabase } from './supabase';
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const base = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');
export async function request<T>(path: string, options: { method?: string; body?: unknown; public?: boolean; signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.public) {
    const { data, error } = await getSupabase().auth.getSession();
    if (error || !data.session) throw new ApiError(401, 'Please sign in to continue.');
    headers.Authorization = 'Bearer ' + data.session.access_token;
  }
  const response = await fetch(base + path, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, typeof body?.error?.message === 'string' ? body.error.message : 'The request could not be completed.');
  return body as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Unable to complete the request. Please try again.';
}
