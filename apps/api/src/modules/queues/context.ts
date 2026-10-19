import type { PoolClient } from 'pg';
import { businessScope, serviceAccess, missing } from '../configuration/access.js';
import { HttpError } from '../../shared/http-error.js';
export interface QueueIds { businessId: string; branchId: string; serviceId: string; }
export interface QueueActor { userId: string; type: 'STAFF' | 'CUSTOMER' | 'SYSTEM'; }
export interface QueueContext extends QueueIds {
  businessDate: string; timezone: string; serviceName: string; branchName: string; prefix: string;
  businessActive: boolean; branchActive: boolean; serviceActive: boolean; paymentMode: string; price: string;
}
export const conflict = (message: string, code = 'QUEUE_CONFLICT') => new HttpError(409, code, message);
export async function authorizeQueue(client: PoolClient, ids: QueueIds, userId: string): Promise<void> {
  const scope = await businessScope(client, ids.businessId, userId, false);
  // Deliberately READ configuration scope: assigned STAFF may operate queues,
  // while the Phase 2 write guard continues to deny configuration changes.
  await serviceAccess(client, scope, ids.branchId, ids.serviceId, false);
}
export async function lockQueueContext(client: PoolClient, ids: QueueIds, write = true): Promise<QueueContext> {
  // Same lock order as configuration: business -> service -> session -> request/ticket/counter.
  const business = await client.query('SELECT id FROM public.businesses WHERE id=$1 FOR SHARE', [ids.businessId]);
  if (!business.rowCount) throw missing();
  const result = await client.query<QueueContext>(`SELECT
    (clock_timestamp() AT TIME ZONE br.timezone)::date::text AS "businessDate", br.timezone,
    s.name AS "serviceName", br.name AS "branchName", s.queue_prefix AS prefix,
    b.is_active AS "businessActive", br.is_active AS "branchActive", s.is_active AS "serviceActive",
    s.payment_mode AS "paymentMode", s.price_amount::text AS price
    FROM public.services s JOIN public.branches br ON br.business_id=s.business_id AND br.id=s.branch_id
    JOIN public.businesses b ON b.id=s.business_id
    WHERE s.business_id=$1 AND s.branch_id=$2 AND s.id=$3
    ${write ? 'FOR UPDATE' : 'FOR SHARE'} OF s`, [ids.businessId, ids.branchId, ids.serviceId]);
  if (!result.rows[0]) throw missing();
  return { ...result.rows[0], ...ids };
}
export function requireActive(context: QueueContext): void {
  if (!context.businessActive || !context.branchActive || !context.serviceActive) throw conflict('Business, branch and service must be active.');
}
