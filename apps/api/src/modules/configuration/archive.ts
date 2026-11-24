import type { PoolClient } from 'pg';
import { HttpError } from '../../shared/http-error.js';
import { missing } from './access.js';

// Caller holds the exclusive business lock, including across the eligibility checks.
// Queue admission and checkout take a shared lock on the same business first.
export async function archiveResource(client: PoolClient, businessId: string, serviceId: string | null, actor: string, name: string) {
  const resource = serviceId
    ? await client.query('SELECT name FROM public.services WHERE business_id=$1 AND id=$2 AND archived_at IS NULL',[businessId,serviceId])
    : await client.query('SELECT name FROM public.businesses WHERE id=$1 AND archived_at IS NULL',[businessId]);
  if (!resource.rows[0]) throw missing();
  if (resource.rows[0].name !== name) throw new HttpError(409,'NAME_MISMATCH','The name has changed or does not match. Refresh and confirm the current name.');
  const checks = await client.query(`SELECT
    EXISTS(SELECT FROM public.queue_sessions q
      JOIN public.branches b ON b.id=q.branch_id AND b.business_id=q.business_id
      WHERE q.business_id=$1 AND ($2::uuid IS NULL OR q.service_id=$2)
        AND q.status IN ('OPEN','PAUSED') AND q.business_date >= (statement_timestamp() AT TIME ZONE b.timezone)::date) AS sessions,
    EXISTS(SELECT FROM public.queue_tickets WHERE business_id=$1 AND ($2 IS NULL OR service_id=$2) AND status IN ('WAITING','CALLED','SERVING')) AS tickets,
    EXISTS(SELECT FROM public.join_requests j WHERE j.business_id=$1 AND ($2 IS NULL OR j.service_id=$2) AND
      (j.status='RECONCILIATION_REQUIRED' OR (j.status IN ('READY','PAYMENT_PENDING') AND j.expires_at>clock_timestamp())
       OR EXISTS(SELECT FROM public.payments p WHERE p.join_request_id=j.id AND ((p.status='PENDING' AND (p.provider<>'MOCK' OR least(p.expires_at,j.expires_at)>statement_timestamp())) OR p.reconciliation_reason IS NOT NULL)))) AS payments`,[businessId,serviceId]);
  const {sessions,tickets,payments} = checks.rows[0];
  if (sessions || tickets || payments) throw new HttpError(409,'ARCHIVE_BLOCKED',
    sessions ? 'Close the open or paused queue for the current business date first.' :
    tickets ? 'Finish or cancel the remaining active tickets, including previous days.' : 'An unfinished request, payment or reconciliation needs attention.');
  if (serviceId) {
    await client.query('UPDATE public.services SET archived_at=clock_timestamp(), archived_by=$3, is_active=false WHERE business_id=$1 AND id=$2',[businessId,serviceId,actor]);
  } else {
    await client.query('UPDATE public.businesses SET archived_at=clock_timestamp(), archived_by=$2, is_active=false WHERE id=$1',[businessId,actor]);
  }
  return {archived:true};
}
