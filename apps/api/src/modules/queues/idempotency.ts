import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { QueueCommandResult } from '@qevra/contracts';
import { conflict, type QueueIds } from './context.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export async function idempotentCommand<T = QueueCommandResult>(client: PoolClient, ids: QueueIds, actorId: string, key: string, command: string, body: unknown, execute: () => Promise<T>): Promise<T> {
  const hash = createHash('sha256').update(canonical({ ...ids, command, body })).digest('hex');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [actorId + ':' + key]);
  const cached = await client.query<{ request_hash: string; response: T }>('SELECT request_hash, response FROM public.queue_command_keys WHERE actor_user_id=$1 AND idempotency_key=$2', [actorId, key]);
  if (cached.rows[0]) {
    if (cached.rows[0].request_hash !== hash) throw conflict('This idempotency key was used for a different command.', 'IDEMPOTENCY_CONFLICT');
    return cached.rows[0].response;
  }
  const response = await execute();
  await client.query('INSERT INTO public.queue_command_keys(actor_user_id,idempotency_key,business_id,branch_id,service_id,request_hash,response) VALUES ($1,$2,$3,$4,$5,$6,$7)', [actorId,key,ids.businessId,ids.branchId,ids.serviceId,hash,JSON.stringify(response)]);
  return response;
}
