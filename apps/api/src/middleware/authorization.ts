import type { RequestHandler } from 'express';
import { BusinessRole, uuidSchema } from '@qevra/contracts';
import { getPool } from '../db/client.js';
import { HttpError } from '../shared/http-error.js';

// Compose AFTER requireAuth and requireStaff. Branch/service scope will be added
// with their Phase 2 endpoints; membership alone must never grant branch operations.
export function requireBusinessRole(roles: readonly BusinessRole[]): RequestHandler {
  return async (req, _res, next) => {
    if (!req.actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    if (req.actor.isAnonymous) throw new HttpError(403, 'FORBIDDEN', 'Staff authentication is required.');
    const businessId = uuidSchema.safeParse(req.params.businessId);
    if (!businessId.success) throw new HttpError(400, 'INVALID_BUSINESS_ID', 'Invalid business identifier.');
    const result = await getPool().query<{ id: string; role: BusinessRole }>(
      `SELECT m.id, m.role FROM public.business_members m
       JOIN public.businesses b ON b.id = m.business_id
       WHERE m.business_id = $1 AND m.user_id = $2 AND m.is_active AND b.is_active`,
      [businessId.data, req.actor.userId],
    );
    const membership = result.rows[0];
    if (!membership || !roles.includes(membership.role)) throw new HttpError(403, 'FORBIDDEN', 'Business access denied.');
    req.membership = { ...membership, businessId: businessId.data };
    next();
  };
}
