import {customerNotifications} from '../notifications/service.js';
import {mockWhatsAppEnabled} from '../../config/env.js';
import { paymentService } from '../payments/service.js';
import type {PoolClient} from 'pg';
import {formatQueueNumber,type CustomerJoinResult,type CustomerJoinData,type CustomerTicketSnapshot,type ActiveCustomerTicket,type QueueCommandResult} from '@qevra/contracts';
import {missing} from '../configuration/access.js';
import {lockQueueContext,conflict,type QueueIds} from '../queues/context.js';
import {session,transition} from '../queues/engine.js';
import {admitJoinRequest} from '../queues/admission.js';
import {idempotentCommand} from '../queues/idempotency.js';
import {CounterEtaCalculator} from './eta.js';
export async function activeTicket(client:PoolClient,userId:string,serviceId:string):Promise<ActiveCustomerTicket|null>{
  const row=(await client.query(`SELECT id,service_id,prefix_snapshot,sequence_number,status FROM public.queue_tickets
    WHERE customer_auth_id=$1 AND service_id=$2 AND status IN ('WAITING','CALLED','SERVING') ORDER BY joined_at DESC LIMIT 1`,[userId,serviceId])).rows[0];
  return row?{ticketId:row.id,serviceId:row.service_id,queueNumber:formatQueueNumber(row.prefix_snapshot,row.sequence_number),status:row.status}:null;
}
export async function join(client:PoolClient,userId:string,key:string,data:CustomerJoinData,mockEnabled=false):Promise<CustomerJoinResult>{
  const scope=(await client.query<QueueIds>(`SELECT s.business_id AS "businessId",s.branch_id AS "branchId",s.id AS "serviceId"
    FROM public.services s JOIN public.branches br ON br.id=s.branch_id WHERE s.id=$1 AND br.public_slug=$2`,[data.serviceId,data.branchSlug])).rows[0];
  if(!scope)throw missing();
  // Match staff mutation lock ordering before the shared idempotency helper.
  await client.query('SELECT id FROM public.businesses WHERE id=$1 FOR SHARE',[scope.businessId]);
  return idempotentCommand<CustomerJoinResult>(client,scope,userId,key,'customer/join',data,async()=>{
    const context=await lockQueueContext(client,scope);
    const existing=await activeTicket(client,userId,scope.serviceId);
    if(existing){
      const row=(await client.query('SELECT s.id,s.revision::text FROM public.queue_sessions s JOIN public.queue_tickets t ON t.queue_session_id=s.id WHERE t.id=$1',[existing.ticketId])).rows[0];
      return {outcome:'UNCHANGED',sessionId:row.id,ticketId:existing.ticketId,revision:row.revision};
    }
    const checkout=await paymentService.existingCheckout(client,userId,context);
    if(checkout)return checkout;
    if(!context.businessActive || !context.branchActive || !context.serviceActive)throw conflict('This service is unavailable.','SERVICE_UNAVAILABLE');
    if(context.paymentMode!=='NONE'&&!mockEnabled)throw conflict('Online payment queue joining is not available yet.','PAID_JOIN_UNAVAILABLE');
    const current=await session(client,context);
    if(!current)throw conflict('The queue has not opened yet.','QUEUE_NOT_OPENED');
    if(current.status!=='OPEN')throw conflict(current.status==='PAUSED'?'The queue is temporarily paused.':'The queue is closed.',current.status==='PAUSED'?'QUEUE_PAUSED':'QUEUE_CLOSED');
    if(context.paymentMode!=='NONE')return paymentService.createJoin(client,userId,context,current,data);
    const request=(await client.query(`INSERT INTO public.join_requests(business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,phone_e164,whatsapp_opt_in_at,status,payment_mode_snapshot,price_snapshot,amount_due,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $9::boolean THEN clock_timestamp() ELSE NULL END,'READY','NONE',$8,0,clock_timestamp()+interval '15 minutes') RETURNING id`,
      [scope.businessId,scope.branchId,scope.serviceId,current.id,userId,data.customerName,data.phone??null,context.price,data.whatsappOptIn])).rows[0];
    return admitJoinRequest(client,scope,{userId,type:'CUSTOMER'},request.id);
  });
}
async function ownedScope(client:PoolClient,userId:string,ticketId:string):Promise<QueueIds>{
  const scope=(await client.query<QueueIds>('SELECT business_id AS "businessId",branch_id AS "branchId",service_id AS "serviceId" FROM public.queue_tickets WHERE id=$1 AND customer_auth_id=$2',[ticketId,userId])).rows[0];
  if(!scope)throw missing();
  return scope;
}
export async function cancel(client:PoolClient,userId:string,ticketId:string,key:string,expectedVersion:number):Promise<QueueCommandResult>{
  const scope=await ownedScope(client,userId,ticketId);
  await client.query('SELECT id FROM public.businesses WHERE id=$1 FOR SHARE',[scope.businessId]);
  return idempotentCommand(client,scope,userId,key,'customer/cancel/'+ticketId,{expectedVersion},async()=>{
    const context=await lockQueueContext(client,scope);
    const ticket=(await client.query('SELECT status FROM public.queue_tickets WHERE id=$1 AND customer_auth_id=$2',[ticketId,userId])).rows[0];
    if(!ticket)throw missing();
    if(ticket.status!=='WAITING')throw conflict('Only a waiting ticket can be cancelled. Please contact staff.','CANNOT_CANCEL');
    return transition(client,context,{userId,type:'CUSTOMER'},ticketId,'cancel',{expectedVersion});
  });
}
export async function ticketSnapshot(client:PoolClient,userId:string,ticketId:string):Promise<CustomerTicketSnapshot>{
  const scope=await ownedScope(client,userId,ticketId);
  const context=await lockQueueContext(client,scope,false);
  const ticket=(await client.query(`SELECT t.id,t.status,t.version,t.joined_at,t.prefix_snapshot,t.sequence_number,t.queue_order,t.queue_session_id,
    s.status AS session_status,s.business_date::text,s.revision::text,b.name AS business_name,br.public_slug,br.address,sv.estimated_duration_minutes
    FROM public.queue_tickets t JOIN public.queue_sessions s ON s.id=t.queue_session_id JOIN public.businesses b ON b.id=t.business_id
    JOIN public.branches br ON br.id=t.branch_id JOIN public.services sv ON sv.id=t.service_id
    WHERE t.id=$1 AND t.customer_auth_id=$2`,[ticketId,userId])).rows[0];
  if(!ticket)throw missing();
  const peopleAhead=(await client.query<{count:number}>("SELECT count(*)::int AS count FROM public.queue_tickets WHERE queue_session_id=$1 AND status='WAITING' AND queue_order<$2",[ticket.queue_session_id,ticket.queue_order])).rows[0]!.count;
  const counters=(await client.query(`SELECT t.status,t.serving_at AS "servingAt" FROM public.service_counters c
    LEFT JOIN public.queue_tickets t ON t.counter_id=c.id AND t.status IN ('CALLED','SERVING')
    WHERE c.service_id=$1 AND c.is_active`,[scope.serviceId])).rows;
  const handling=(await client.query("SELECT prefix_snapshot,sequence_number FROM public.queue_tickets WHERE service_id=$1 AND status IN ('CALLED','SERVING') ORDER BY called_at,id",[scope.serviceId])).rows;
  const now=new Date();
  const eta=new CounterEtaCalculator().calculate({now,peopleAhead,durationMinutes:ticket.estimated_duration_minutes,
    sessionOpen:ticket.session_status==='OPEN' && ticket.business_date===context.businessDate,
    serviceActive:context.businessActive&&context.branchActive&&context.serviceActive,waiting:ticket.status==='WAITING',counters});
  return {
    notifications:await customerNotifications(client,userId,ticketId),mockWhatsAppAvailable:mockWhatsAppEnabled,
    ticket:{id:ticket.id,queueNumber:formatQueueNumber(ticket.prefix_snapshot,ticket.sequence_number),status:ticket.status,version:ticket.version,joinedAt:ticket.joined_at.toISOString()},
    business:{name:ticket.business_name},branch:{name:context.branchName,publicSlug:ticket.public_slug,address:ticket.address},service:{id:scope.serviceId,name:context.serviceName},
    queue:{...eta,sessionStatus:ticket.session_status,nowServing:handling.map(t=>formatQueueNumber(t.prefix_snapshot,t.sequence_number)),revision:ticket.revision,generatedAt:now.toISOString(),realtimeTopic:'queue:'+ticket.queue_session_id},
  };
}
