import type { PoolClient, QueryResultRow } from 'pg';
import { BusinessRole, type BusinessDto, type BranchDto, type ServiceDto, type CounterDto, type MemberDto } from '@qevra/contracts';
import { missing, type Scope } from './access.js';
export const branchColumns = 'id, business_id, name, public_slug, timezone, address, is_active';
export const serviceColumns = 'id, business_id, branch_id, name, description, price_amount::text, currency, estimated_duration_minutes, queue_prefix, payment_mode, deposit_amount::text, is_active';
export const counterColumns = 'id, business_id, branch_id, service_id, name, is_active';
export async function one<T extends QueryResultRow>(client: PoolClient, text: string, values: unknown[]): Promise<T> {
  const result = await client.query<T>(text, values);
  if (!result.rows[0]) throw missing();
  return result.rows[0];
}
export async function businessDto(client: PoolClient, scope: Scope): Promise<BusinessDto> {
  const result = await one<{ id: string; name: string; slug: string; is_active: boolean }>(client, 'SELECT id, name, slug, is_active FROM public.businesses WHERE id = $1', [scope.businessId]);
  return { id: result.id, name: result.name, slug: result.slug, status: result.is_active ? 'ACTIVE' : 'INACTIVE', role: scope.role };
}
export const branchDto = (client: PoolClient, businessId: string, branchId: string) => one<BranchDto>(client, 'SELECT ' + branchColumns + ' FROM public.branches WHERE business_id = $1 AND id = $2', [businessId, branchId]);
export const serviceDto = (client: PoolClient, businessId: string, branchId: string, serviceId: string) => one<ServiceDto>(client, 'SELECT ' + serviceColumns + ' FROM public.services WHERE business_id = $1 AND branch_id = $2 AND id = $3', [businessId, branchId, serviceId]);
export const counterDto = (client: PoolClient, businessId: string, branchId: string, serviceId: string, counterId: string) => one<CounterDto>(client, 'SELECT ' + counterColumns + ' FROM public.service_counters WHERE business_id = $1 AND branch_id = $2 AND service_id = $3 AND id = $4', [businessId, branchId, serviceId, counterId]);
export async function members(client: PoolClient, businessId: string): Promise<MemberDto[]> {
  const result = await client.query<MemberDto>(`SELECT m.id, m.user_id, p.display_name, p.normalized_email, m.role, m.is_active,
    ARRAY(SELECT bm.branch_id FROM public.branch_members bm WHERE bm.business_id = m.business_id AND bm.member_id = m.id ORDER BY bm.branch_id) AS branch_ids,
    ARRAY(SELECT ss.service_id FROM public.staff_services ss WHERE ss.business_id = m.business_id AND ss.member_id = m.id ORDER BY ss.service_id) AS service_ids
    FROM public.business_members m JOIN public.profiles p ON p.user_id = m.user_id
    WHERE m.business_id = $1 ORDER BY p.display_name, m.id`, [businessId]);
  return result.rows;
}
export async function listBranches(client: PoolClient, scope: Scope): Promise<BranchDto[]> {
  return (await client.query<BranchDto>(`SELECT ${branchColumns} FROM public.branches b WHERE b.business_id = $1
    AND ($2::boolean OR EXISTS (SELECT 1 FROM public.branch_members bm WHERE bm.business_id = b.business_id AND bm.branch_id = b.id AND bm.member_id = $3))
    ORDER BY b.name, b.id`, [scope.businessId, scope.role === BusinessRole.OWNER, scope.memberId])).rows;
}
export async function listServices(client: PoolClient, scope: Scope, branchId: string): Promise<ServiceDto[]> {
  return (await client.query<ServiceDto>(`SELECT ${serviceColumns} FROM public.services s WHERE s.business_id = $1 AND s.branch_id = $2
    AND ($3::boolean OR EXISTS (SELECT 1 FROM public.staff_services ss WHERE ss.business_id = s.business_id AND ss.branch_id = s.branch_id AND ss.service_id = s.id AND ss.member_id = $4))
    ORDER BY s.name, s.id`, [scope.businessId, branchId, scope.role !== BusinessRole.STAFF, scope.memberId])).rows;
}
