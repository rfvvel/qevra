import {notificationService} from '../notifications/service.js';
import type { PoolClient } from 'pg';
import { ticketTransitions, type TicketAction, type QueueCommandResult } from '@qevra/contracts';
import { conflict, requireActive, type QueueContext, type QueueActor } from './context.js';
import { missing } from '../configuration/access.js';
export interface Session { id: string; status: string; business_date: string; revision: string; }
export async function session(client: PoolClient, context: QueueContext, sessionId?: string): Promise<Session | undefined> {
  return (await client.query<Session>(`SELECT id,status,business_date::text,revision::text FROM public.queue_sessions
    WHERE service_id=$1 AND business_id=$2 AND ${sessionId ? 'id=$3' : 'business_date=$3::date'} FOR UPDATE`,
    [context.serviceId,context.businessId,sessionId ?? context.businessDate])).rows[0];
}
export function requireOpen(context: QueueContext, value?: Session): asserts value is Session {
  requireActive(context);
  if (!value || value.status !== 'OPEN' || value.business_date !== context.businessDate) throw conflict('The current daily queue must be open.');
}
export async function event(client: PoolClient, context: QueueContext, actor: QueueActor, value: Session,
  ticketId: string | null, name: string, from: string | null, to: string, metadata: Record<string,unknown> = {}): Promise<string> {
  const domainEvent=await client.query<{id:string}>(`INSERT INTO public.queue_events(business_id,queue_session_id,queue_ticket_id,event_type,
    from_status,to_status,from_session_status,to_session_status,actor_user_id,actor_type,metadata,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()) RETURNING id`,
    [context.businessId,value.id,ticketId,name,ticketId ? from : null,ticketId ? to : null,
      ticketId ? null : from,ticketId ? null : to,actor.userId,actor.type,JSON.stringify(metadata)]);
  await notificationService.handleQueueEvent(client,context,{id:domainEvent.rows[0]!.id,name,ticketId,sessionId:value.id});
  return (await client.query<{revision:string}>('UPDATE public.queue_sessions SET revision=revision+1 WHERE id=$1 RETURNING revision::text',[value.id])).rows[0]!.revision;
}
export async function control(client: PoolClient, context: QueueContext, actor: QueueActor, action: string,
  data: {sessionId?:string;expectedRevision?:string}): Promise<QueueCommandResult> {
  let value = await session(client,context,data.sessionId);
  if (action === 'open') {
    requireActive(context);
    if (value) {
      if (value.status !== 'OPEN') throw conflict('Use resume for a paused queue. A closed daily queue cannot reopen.');
      return {outcome:'UNCHANGED',sessionId:value.id,ticketId:null,revision:value.revision};
    }
    value = (await client.query<Session>(`INSERT INTO public.queue_sessions(business_id,branch_id,service_id,business_date)
      VALUES($1,$2,$3,$4) RETURNING id,status,business_date::text,revision::text`,
      [context.businessId,context.branchId,context.serviceId,context.businessDate])).rows[0]!;
    return {outcome:'APPLIED',sessionId:value.id,ticketId:null,revision:await event(client,context,actor,value,null,'QUEUE_OPENED',null,'OPEN')};
  }
  if (!value) throw missing();
  if (value.revision !== data.expectedRevision) throw conflict('Queue changed. Refresh before trying again.','STALE_REVISION');
  const target = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'OPEN' : 'CLOSED';
  if ((action === 'pause' && value.status !== 'OPEN') || (action === 'resume' && value.status !== 'PAUSED') || value.status === 'CLOSED') throw conflict('Invalid session transition.');
  if (action === 'resume') { requireActive(context); if(value.business_date !== context.businessDate) throw conflict('A previous daily queue cannot resume.'); }
  await client.query("UPDATE public.queue_sessions SET status=$2::public.queue_session_status,closed_at=CASE WHEN $2::public.queue_session_status='CLOSED' THEN clock_timestamp() ELSE NULL END WHERE id=$1",[value.id,target]);
  return {outcome:'APPLIED',sessionId:value.id,ticketId:null,revision:await event(client,context,actor,value,null,action==='resume'?'QUEUE_RESUMED':'QUEUE_'+target,value.status,target)};
}
async function availableCounter(client: PoolClient, context: QueueContext, counterId: string) {
  const counter = await client.query('SELECT id,is_active FROM public.service_counters WHERE business_id=$1 AND branch_id=$2 AND service_id=$3 AND id=$4 FOR UPDATE',[context.businessId,context.branchId,context.serviceId,counterId]);
  if(!counter.rows[0]) throw missing();
  if(!counter.rows[0].is_active) throw conflict('Counter is inactive.');
  if((await client.query("SELECT id FROM public.queue_tickets WHERE counter_id=$1 AND status IN ('CALLED','SERVING')",[counterId])).rowCount) throw conflict('Counter is busy.','COUNTER_BUSY');
}
export async function transition(client: PoolClient, context: QueueContext, actor: QueueActor, ticketId: string,
  action: TicketAction, data: {expectedVersion:number;counterId?:string;reason?:string;automatic?:boolean}): Promise<QueueCommandResult> {
  const reference = (await client.query('SELECT queue_session_id FROM public.queue_tickets WHERE business_id=$1 AND service_id=$2 AND id=$3',[context.businessId,context.serviceId,ticketId])).rows[0];
  if(!reference) throw missing();
  const value = (await session(client,context,reference.queue_session_id))!;
  const ticket = (await client.query('SELECT * FROM public.queue_tickets WHERE id=$1 FOR UPDATE',[ticketId])).rows[0]!;
  if(ticket.version !== data.expectedVersion) throw conflict('Ticket changed. Refresh before trying again.','STALE_VERSION');
  const rule=ticketTransitions[action];
  if(!rule.from.includes(ticket.status)) throw conflict('Invalid ticket transition.');
  let order=ticket.queue_order;
  let outOfOrder=false;
  if(action==='call' || action==='requeue') requireOpen(context,value);
  if(action==='call') {
    if(!data.counterId) throw conflict('Choose a counter.');
    await availableCounter(client,context,data.counterId);
    const earlier=await client.query("SELECT id FROM public.queue_tickets WHERE queue_session_id=$1 AND status='WAITING' AND queue_order<$2 LIMIT 1",[value.id,ticket.queue_order]);
    outOfOrder=Boolean(earlier.rowCount);
    if(outOfOrder && !data.reason) throw conflict('A reason is required to call out of order.','REASON_REQUIRED');
  }
  if(action==='requeue') order=(await client.query('UPDATE public.queue_sessions SET next_order=next_order+1 WHERE id=$1 RETURNING next_order',[value.id])).rows[0]!.next_order;
  const timestamp: Record<TicketAction,string>={call:'called_at',start:'serving_at',complete:'completed_at',skip:'skipped_at','no-show':'no_show_at',cancel:'cancelled_at',requeue:'skipped_at'};
  const timeSql=action==='requeue' ? 'called_at=NULL,serving_at=NULL,skipped_at=NULL' : timestamp[action]+'=clock_timestamp()';
  const counter=action==='call' ? data.counterId : action==='start' ? ticket.counter_id : null;
  await client.query(`UPDATE public.queue_tickets SET status=$2,version=version+1,queue_order=$3,counter_id=$4,${timeSql} WHERE id=$1`,[ticketId,rule.to,order,counter]);
  const metadata:Record<string,unknown>={};
  if(action==='call') { metadata.counterId=data.counterId; metadata.manual=!data.automatic; metadata.outOfOrder=outOfOrder; if(data.reason) metadata.reason=data.reason; }
  const revision=await event(client,context,actor,value,ticketId,({call:'TICKET_CALLED',start:'SERVICE_STARTED',complete:'SERVICE_COMPLETED',skip:'TICKET_SKIPPED','no-show':'TICKET_NO_SHOW',requeue:'TICKET_REQUEUED',cancel:'TICKET_CANCELLED'}[action]),ticket.status,rule.to,metadata);
  return {outcome:'APPLIED',sessionId:value.id,ticketId,revision};
}
export async function callNext(client: PoolClient,context:QueueContext,actor:QueueActor,data:{counterId:string;sessionId?:string}):Promise<QueueCommandResult>{
  const value=await session(client,context,data.sessionId); requireOpen(context,value);
  await availableCounter(client,context,data.counterId);
  const ticket=(await client.query("SELECT id,version FROM public.queue_tickets WHERE queue_session_id=$1 AND status='WAITING' ORDER BY queue_order LIMIT 1 FOR UPDATE",[value.id])).rows[0];
  if(!ticket) return {outcome:'EMPTY',sessionId:value.id,ticketId:null,revision:value.revision};
  return transition(client,context,actor,ticket.id,'call',{expectedVersion:ticket.version,counterId:data.counterId,automatic:true});
}
