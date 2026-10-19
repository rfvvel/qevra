import type { PoolClient } from 'pg';
import type { QueueCommandResult } from '@qevra/contracts';
import { authorizeQueue, lockQueueContext, conflict, type QueueActor, type QueueIds } from './context.js';
import { session, requireOpen, event } from './engine.js';
import { missing } from '../configuration/access.js';
// Internal only: caller supplies a verified actor and owns the SQL transaction.
export async function admitJoinRequest(client:PoolClient,ids:QueueIds,actor:QueueActor,requestId:string):Promise<QueueCommandResult>{
  if(actor.type==='STAFF') await authorizeQueue(client,ids,actor.userId);
  const context=await lockQueueContext(client,ids);
  const ref=(await client.query('SELECT queue_session_id FROM public.join_requests WHERE id=$1 AND business_id=$2 AND branch_id=$3 AND service_id=$4',[requestId,ids.businessId,ids.branchId,ids.serviceId])).rows[0];
  if(!ref) throw missing();
  const value=(await session(client,context,ref.queue_session_id))!;
  const request=(await client.query('SELECT *,expires_at>clock_timestamp() AS unexpired FROM public.join_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0]!;
  if(actor.type==='CUSTOMER' && request.customer_auth_id!==actor.userId) throw missing();
  if(request.status==='ADMITTED'){
    const existing=(await client.query('SELECT id FROM public.queue_tickets WHERE join_request_id=$1',[requestId])).rows[0];
    if(!existing) throw conflict('Admission record is inconsistent.');
    return {outcome:'UNCHANGED',sessionId:value.id,ticketId:existing.id,revision:value.revision};
  }
  requireOpen(context,value);
  if(!request.unexpired) throw conflict('Join request has expired.','REQUEST_EXPIRED');
  if(request.payment_mode_snapshot==='NONE'){
    if(request.status!=='READY'||context.paymentMode!=='NONE'||String(request.amount_due)!=='0')throw conflict('Join request is not eligible.');
  }else{
    if(request.status!=='PAYMENT_PENDING')throw conflict('Join request is not eligible for admission.');
    const paid=await client.query("SELECT 1 FROM public.payments WHERE business_id=$1 AND join_request_id=$2 AND status='PAID' AND is_settlement AND amount=$3 AND currency=$4",[ids.businessId,requestId,request.amount_due,request.currency]);
    if(!paid.rowCount)throw conflict('A verified payment is required.','PAYMENT_REQUIRED');
  }
  if((await client.query("SELECT id FROM public.queue_tickets WHERE service_id=$1 AND customer_auth_id=$2 AND status IN ('WAITING','CALLED','SERVING')",[ids.serviceId,request.customer_auth_id])).rowCount) throw conflict('Customer already has an active ticket.','ACTIVE_TICKET_EXISTS');
  const numbers=(await client.query('UPDATE public.queue_sessions SET last_number=last_number+1,next_order=next_order+1 WHERE id=$1 RETURNING last_number,next_order',[value.id])).rows[0]!;
  const ticket=(await client.query(`INSERT INTO public.queue_tickets(business_id,branch_id,service_id,queue_session_id,join_request_id,customer_auth_id,sequence_number,prefix_snapshot,queue_order)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[ids.businessId,ids.branchId,ids.serviceId,value.id,requestId,request.customer_auth_id,numbers.last_number,context.prefix,numbers.next_order])).rows[0]!;
  await client.query("UPDATE public.join_requests SET status='ADMITTED',admitted_at=clock_timestamp() WHERE id=$1",[requestId]);
  return {outcome:'APPLIED',sessionId:value.id,ticketId:ticket.id,revision:await event(client,context,actor,value,ticket.id,'TICKET_ADMITTED',null,'WAITING')};
}
