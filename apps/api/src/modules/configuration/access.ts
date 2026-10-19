import type { PoolClient } from 'pg';
import { BusinessRole } from '@qevra/contracts';
import { HttpError } from '../../shared/http-error.js';
export interface Scope { businessId: string; memberId: string; role: BusinessRole; }
export const missing = () => new HttpError(404, 'NOT_FOUND', 'The requested resource is unavailable.');
export const forbidden = () => new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action.');
export function allow(scope: Scope, roles: BusinessRole[]): void { if (!roles.includes(scope.role)) throw forbidden(); }

// Read locks prevent scope revocation midway through a read. Every mutation takes
// the same business lock BEFORE loading current membership, serializing role and
// assignment changes and protecting the last active OWNER.
export async function businessScope(client: PoolClient, businessId: string, userId: string, write: boolean): Promise<Scope> {
  const business = await client.query<{ is_active: boolean }>(
    'SELECT is_active FROM public.businesses WHERE id = $1 ' + (write ? 'FOR UPDATE' : 'FOR SHARE'), [businessId]);
  if (!business.rows[0]) throw missing();
  const member = await client.query<{ id: string; role: BusinessRole }>(
    'SELECT id, role FROM public.business_members WHERE business_id = $1 AND user_id = $2 AND is_active', [businessId, userId]);
  const row = member.rows[0];
  if (!row || (!business.rows[0].is_active && row.role !== BusinessRole.OWNER)) throw missing();
  return { businessId, memberId: row.id, role: row.role };
}
export async function branchAccess(client: PoolClient, scope: Scope, branchId: string, write: boolean): Promise<void> {
  if (write) allow(scope, [BusinessRole.OWNER, BusinessRole.MANAGER]);
  const branch = await client.query('SELECT id FROM public.branches WHERE business_id = $1 AND id = $2', [scope.businessId, branchId]);
  if (!branch.rowCount) throw missing();
  if (scope.role !== BusinessRole.OWNER) {
    const assignment = await client.query('SELECT 1 FROM public.branch_members WHERE business_id = $1 AND branch_id = $2 AND member_id = $3', [scope.businessId, branchId, scope.memberId]);
    if (!assignment.rowCount) throw missing();
  }
}
export async function serviceAccess(client: PoolClient, scope: Scope, branchId: string, serviceId: string, write: boolean): Promise<void> {
  await branchAccess(client, scope, branchId, write);
  const service = await client.query('SELECT id FROM public.services WHERE business_id = $1 AND branch_id = $2 AND id = $3', [scope.businessId, branchId, serviceId]);
  if (!service.rowCount) throw missing();
  if (scope.role === BusinessRole.STAFF) {
    const assignment = await client.query('SELECT 1 FROM public.staff_services WHERE business_id = $1 AND branch_id = $2 AND service_id = $3 AND member_id = $4', [scope.businessId, branchId, serviceId, scope.memberId]);
    if (!assignment.rowCount) throw missing();
  }
}
