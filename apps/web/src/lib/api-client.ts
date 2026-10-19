import { healthResponseSchema, type HealthResponse } from '@qevra/contracts';

const base = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');
export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch(`${base}/health`);
  if (!response.ok) throw new Error('Qevra API is unavailable.');
  return healthResponseSchema.parse(await response.json());
}

export async function getDatabaseHealth(): Promise<boolean> {
  const response = await fetch(`${base}/health/database`);
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'database' in body && body.database === 'connected';
}

export async function verifySession(accessToken: string, staff = false): Promise<boolean> {
  const response = await fetch(`${base}/auth/${staff ? 'staff' : 'session'}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.ok;
}
