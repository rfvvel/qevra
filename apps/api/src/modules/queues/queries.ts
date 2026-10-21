import type {PoolClient} from 'pg';
import {formatQueueNumber,type QueueSnapshot,type QueueHistory,type QueueTicketDto,type QueueSessionDto} from '@qevra/contracts';
import type {QueueContext} from './context.js';
export async function snapshot(client:PoolClient,context:QueueContext):Promise<QueueSnapshot>{
  const current=(await client.query<QueueSessionDto>('SELECT id,business_date::text AS "businessDate",status,revision::text FROM public.queue_sessions WHERE service_id=$1 AND business_date=$2',[context.serviceId,context.businessDate])).rows[0] ?? null;
  const rows=(await client.query<QueueTicketDto & {prefix:string}>(`SELECT t.id,t.queue_session_id AS "sessionId",s.business_date::text AS "businessDate",
    EXISTS(SELECT 1 FROM public.payments p WHERE p.join_request_id=t.join_request_id AND p.business_id=t.business_id AND p.provider='MOCK' AND p.is_settlement) AS "simulatedPayment",
    t.sequence_number AS "sequenceNumber",t.prefix_snapshot AS prefix,t.queue_order::text AS "queueOrder",t.status,t.counter_id AS "counterId",t.version,j.customer_name AS "customerName",
    t.joined_at AS "joinedAt",t.called_at AS "calledAt",t.serving_at AS "servingAt",t.completed_at AS "completedAt",t.skipped_at AS "skippedAt",t.cancelled_at AS "cancelledAt",t.no_show_at AS "noShowAt"
    FROM public.queue_tickets t JOIN public.queue_sessions s ON s.id=t.queue_session_id JOIN public.join_requests j ON j.id=t.join_request_id
    WHERE t.service_id=$1 AND t.status IN ('WAITING','CALLED','SERVING','SKIPPED') ORDER BY s.business_date,t.queue_order`,[context.serviceId])).rows;
  const tickets=rows.map(({prefix,...row})=>({...row,number:formatQueueNumber(prefix,row.sequenceNumber)}));
  const today=tickets.filter(t=>t.sessionId===current?.id);
  const counters=(await client.query<QueueSnapshot['counters'][number]>(`SELECT c.id,c.name,c.is_active AS "isActive",t.id AS "activeTicketId"
    FROM public.service_counters c LEFT JOIN public.queue_tickets t ON t.counter_id=c.id AND t.status IN ('CALLED','SERVING')
    WHERE c.service_id=$1 ORDER BY c.name,c.id`,[context.serviceId])).rows;
  const completed=(await client.query<{count:number}>(`SELECT count(*)::int AS count FROM public.queue_tickets
    WHERE service_id=$1 AND status='COMPLETED' AND (completed_at AT TIME ZONE $2)::date=$3::date`,[context.serviceId,context.timezone,context.businessDate])).rows[0]!.count;
  return {session:current,businessDate:context.businessDate,timezone:context.timezone,serviceName:context.serviceName,branchName:context.branchName,
    acceptingOperations:context.businessActive && context.branchActive && context.serviceActive,
    revision:current?.revision ?? '0',generatedAt:new Date().toISOString(),waiting:today.filter(t=>t.status==='WAITING'),
    called:today.filter(t=>t.status==='CALLED'),serving:today.filter(t=>t.status==='SERVING'),skipped:today.filter(t=>t.status==='SKIPPED'),
    carryover:tickets.filter(t=>t.sessionId!==current?.id),counters,
    summary:{waitingCount:today.filter(t=>t.status==='WAITING').length,calledCount:today.filter(t=>t.status==='CALLED').length,servingCount:today.filter(t=>t.status==='SERVING').length,completedToday:completed}};
}
export async function history(client:PoolClient,context:QueueContext,query:{businessDate?:string;page:number;limit:number}):Promise<QueueHistory>{
  const rows=(await client.query<QueueHistory['events'][number]>(`SELECT e.id,e.event_type AS "eventType",e.queue_session_id AS "sessionId",e.queue_ticket_id AS "ticketId",
    CASE WHEN t.id IS NULL THEN NULL ELSE t.prefix_snapshot || lpad(t.sequence_number::text,greatest(3,length(t.sequence_number::text)),'0') END AS number,
    coalesce(e.from_status::text,e.from_session_status::text) AS "fromStatus",coalesce(e.to_status::text,e.to_session_status::text) AS "toStatus",
    e.actor_type AS "actorType",e.occurred_at AS "occurredAt",e.metadata
    FROM public.queue_events e JOIN public.queue_sessions s ON s.id=e.queue_session_id LEFT JOIN public.queue_tickets t ON t.id=e.queue_ticket_id
    WHERE s.service_id=$1 AND ($2::date IS NULL OR s.business_date=$2::date)
    ORDER BY e.occurred_at DESC,e.id DESC LIMIT $3 OFFSET $4`,[context.serviceId,query.businessDate ?? null,query.limit+1,(query.page-1)*query.limit])).rows;
  return {events:rows.slice(0,query.limit),page:query.page,hasMore:rows.length>query.limit,generatedAt:new Date().toISOString()};
}
