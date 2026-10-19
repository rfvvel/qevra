import type {PoolClient} from 'pg';
import {formatQueueNumber,type NotificationType,type CustomerNotification,type MockWhatsAppNotification} from '@qevra/contracts';
import {mockWhatsAppEnabled,whatsapp} from '../../config/env.js';
import {missing} from '../configuration/access.js';
import {lockQueueContext,type QueueContext,type QueueIds} from '../queues/context.js';
import {inAppNotificationProvider,mockWhatsAppProvider,type NotificationProvider} from './provider.js';
export const NEAR_TURN_THRESHOLD=3;
export interface QueueNotificationEvent {id:string;name:string;ticketId:string|null;sessionId:string;}
interface Recipient {id:string;customer_auth_id:string;prefix_snapshot:string;sequence_number:number;phone_e164:string|null;whatsapp_opt_in_at:Date|null;people_ahead?:number;}
interface Intent {business_id:string;customer_user_id:string;queue_ticket_id:string;source_event_id:string;channel:'IN_APP'|'MOCK_WHATSAPP';type:NotificationType;title:string;message:string;dedupe_key:string;}
interface Stored extends Intent {id:string;}
const eventTypes:Record<string,NotificationType>={TICKET_ADMITTED:'QUEUE_JOINED',TICKET_CALLED:'YOUR_TURN',SERVICE_STARTED:'SERVICE_STARTED',SERVICE_COMPLETED:'SERVICE_COMPLETED',TICKET_CANCELLED:'QUEUE_CANCELLED',TICKET_SKIPPED:'QUEUE_SKIPPED',TICKET_NO_SHOW:'QUEUE_NO_SHOW'};
function copy(type:NotificationType,r:Recipient):{title:string;message:string}{
  switch(type){
    case 'QUEUE_JOINED':return {title:"You're in the queue",message:"You're in the queue. Your number is "+formatQueueNumber(r.prefix_snapshot,r.sequence_number)+'.'};
    case 'NEAR_TURN':return {title:'Your turn is getting close',message:r.people_ahead===0?"You're next in the waiting queue. Please stay nearby.":'Only '+r.people_ahead+' '+(r.people_ahead===1?'customer is':'customers are')+' ahead of you.'};
    case 'YOUR_TURN':return {title:"It's your turn",message:"It's your turn. Please return to the service area."};
    case 'SERVICE_STARTED':return {title:'Service started',message:'Your service has started.'};
    case 'SERVICE_COMPLETED':return {title:'Service complete',message:'Your service is complete. Thank you.'};
    case 'QUEUE_CANCELLED':return {title:'Ticket cancelled',message:'Your queue ticket has been cancelled.'};
    case 'QUEUE_SKIPPED':return {title:'Your turn was skipped',message:'Your turn was skipped. Please contact staff about rejoining the queue.'};
    case 'QUEUE_NO_SHOW':return {title:'Marked as no-show',message:'Your ticket was marked as no-show. Please contact staff if you still need service.'};
  }
}
export class NotificationService {
  constructor(private readonly inApp:NotificationProvider=inAppNotificationProvider,private readonly whatsapp:NotificationProvider=mockWhatsAppProvider){}
  // The caller has already locked the service/session and persisted the domain event.
  // Current providers are local-only. No external delivery belongs in this transaction.
  async handleQueueEvent(client:PoolClient,context:QueueContext,event:QueueNotificationEvent):Promise<void>{
    await client.query('SAVEPOINT notification_generation');
    try{
      await this.generate(client,context,event);
      await client.query('RELEASE SAVEPOINT notification_generation');
    }catch{
      await client.query('ROLLBACK TO SAVEPOINT notification_generation');
      await client.query('RELEASE SAVEPOINT notification_generation');
      // Even persistence errors are isolated from the primary queue mutation.
      await client.query('SAVEPOINT notification_failure_audit');
      try{
        await client.query("INSERT INTO public.notification_events(business_id,queue_event_id,kind,code) VALUES($1,$2,'GENERATION_FAILED','NOTIFICATION_GENERATION_ERROR')",[context.businessId,event.id]);
        await client.query('RELEASE SAVEPOINT notification_failure_audit');
      }catch{
        await client.query('ROLLBACK TO SAVEPOINT notification_failure_audit');
        await client.query('RELEASE SAVEPOINT notification_failure_audit');
        console.warn('Notification audit unavailable.');
      }
    }
  }
  private async generate(client:PoolClient,context:QueueContext,event:QueueNotificationEvent){
    const recipients=new Map<string,Recipient>(),targets:{recipient:Recipient;type:NotificationType}[]=[];
    const select=`SELECT t.id,t.customer_auth_id,t.prefix_snapshot,t.sequence_number,j.phone_e164,j.whatsapp_opt_in_at
      FROM public.queue_tickets t JOIN public.join_requests j ON j.id=t.join_request_id`;
    const type=eventTypes[event.name];
    if(event.ticketId&&type){
      const r=(await client.query<Recipient>(select+' WHERE t.id=$1 AND t.business_id=$2',[event.ticketId,context.businessId])).rows[0];
      if(r){recipients.set(r.id,r);targets.push({recipient:r,type});}
    }
    if(context.businessActive&&context.branchActive&&context.serviceActive){
      const near=await client.query<Recipient>(`SELECT candidates.*, (row_number() OVER(ORDER BY queue_order)-1)::int AS people_ahead FROM (
        ${select} JOIN public.queue_sessions s ON s.id=t.queue_session_id
        WHERE t.queue_session_id=$1 AND t.business_id=$2 AND t.status='WAITING' AND s.status='OPEN' AND s.business_date=$3::date
        ORDER BY t.queue_order LIMIT $4
      ) candidates`.replace('t.sequence_number,j.phone_e164','t.sequence_number,t.queue_order,j.phone_e164'),[event.sessionId,context.businessId,context.businessDate,NEAR_TURN_THRESHOLD+1]);
      for(const r of near.rows){recipients.set(r.id,r);targets.push({recipient:r,type:'NEAR_TURN'});}
    }
    const intents:Intent[]=[];
    for(const {recipient:r,type} of targets){
      const suffix=['QUEUE_JOINED','NEAR_TURN','SERVICE_COMPLETED'].includes(type)?type:type+':'+event.id;
      for(const channel of ['IN_APP',...(mockWhatsAppEnabled&&r.phone_e164&&r.whatsapp_opt_in_at?['MOCK_WHATSAPP']:[])] as ('IN_APP'|'MOCK_WHATSAPP')[]){
        intents.push({business_id:context.businessId,customer_user_id:r.customer_auth_id,queue_ticket_id:r.id,source_event_id:event.id,channel,type,...copy(type,r),dedupe_key:r.id+':'+suffix});
      }
    }
    if(whatsapp.mode==='META'||whatsapp.mode==='TWILIO'){
      const channel=whatsapp.mode==='TWILIO'?'TWILIO_WHATSAPP':'META_WHATSAPP';
      // Durable intent only: NEVER call the Meta provider from a queue transaction.
      // Same-ticket NEAR_TURN is once-only, including requeues; YOUR_TURN is per call event.
      for(const {recipient:r,type} of targets){
        if(!['NEAR_TURN','YOUR_TURN'].includes(type)||!r.whatsapp_opt_in_at||!/^\+628[0-9]{7,11}$/.test(r.phone_e164??''))continue;
        const content=copy(type,r),key=r.id+':'+(type==='NEAR_TURN'?type:type+':'+event.id);
        await client.query(`WITH intent AS (
          INSERT INTO public.notifications(business_id,customer_user_id,queue_ticket_id,source_event_id,channel,type,title,message,dedupe_key)
          VALUES($1,$2,$3,$4,$9::public.notification_channel,$5,$6,$7,$8) ON CONFLICT(channel,dedupe_key) DO NOTHING RETURNING id,business_id
        ) INSERT INTO public.whatsapp_outbox(business_id,notification_id) SELECT business_id,id FROM intent`,
          [context.businessId,r.customer_auth_id,r.id,event.id,type,content.title,content.message,key,channel]);
      }
    }
    if(!intents.length)return;
    const created=(await client.query<Stored>(`INSERT INTO public.notifications(business_id,customer_user_id,queue_ticket_id,source_event_id,channel,type,title,message,dedupe_key)
      SELECT business_id,customer_user_id,queue_ticket_id,source_event_id,channel::public.notification_channel,type::public.notification_type,title,message,dedupe_key
      FROM jsonb_to_recordset($1::jsonb) AS x(business_id uuid,customer_user_id uuid,queue_ticket_id uuid,source_event_id uuid,channel text,type text,title text,message text,dedupe_key text)
      ON CONFLICT(channel,dedupe_key) DO NOTHING RETURNING *`,[JSON.stringify(intents)])).rows;
    if(!created.length)return;
    const delivered=[];
    for(const row of created){
      const r=recipients.get(row.queue_ticket_id)!;
      try{
        const provider=row.channel==='IN_APP'?this.inApp:this.whatsapp;
        if(provider.channel==='META_WHATSAPP'||provider.channel==='TWILIO_WHATSAPP')throw new Error('External delivery requires the outbox.');
        const result=await provider.send({title:row.title,message:row.message,phone:r.phone_e164,consented:Boolean(r.whatsapp_opt_in_at),dedupeKey:row.dedupe_key});
        delivered.push({id:row.id,status:result.status,recipient_masked:result.recipientMasked??null,code:result.code??null});
      }catch{delivered.push({id:row.id,status:'FAILED',recipient_masked:null,code:'PROVIDER_ERROR'});}
    }
    await client.query(`WITH updates AS (
      UPDATE public.notifications n SET status=x.status::public.notification_status,recipient_masked=x.recipient_masked,failure_code=x.code,
        sent_at=CASE WHEN x.status='SENT' THEN clock_timestamp() ELSE NULL END
      FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,status text,recipient_masked text,code text) WHERE n.id=x.id AND n.business_id=$2
      RETURNING n.*
    ) INSERT INTO public.notification_events(business_id,queue_event_id,notification_id,kind,code)
      SELECT business_id,source_event_id,id,status::text,failure_code FROM updates`,[JSON.stringify(delivered),context.businessId]);
  }
}
export const notificationService=new NotificationService();
export async function customerNotifications(client:PoolClient,userId:string,ticketId:string):Promise<CustomerNotification[]>{
  const rows=await client.query(`SELECT id,type,title,message,created_at,read_at FROM public.notifications
    WHERE customer_user_id=$1 AND queue_ticket_id=$2 AND channel='IN_APP' AND status='SENT' ORDER BY created_at DESC,id DESC LIMIT 50`,[userId,ticketId]);
  return rows.rows.map(r=>({id:r.id,type:r.type,title:r.title,message:r.message,createdAt:r.created_at.toISOString(),readAt:r.read_at?.toISOString()??null}));
}
export async function mockMessages(client:PoolClient,userId:string,ticketId:string):Promise<MockWhatsAppNotification[]>{
  if(!mockWhatsAppEnabled)throw missing();
  if(!(await client.query('SELECT id FROM public.queue_tickets WHERE id=$1 AND customer_auth_id=$2',[ticketId,userId])).rowCount)throw missing();
  const rows=await client.query(`SELECT id,type,title,message,status,recipient_masked,failure_code,created_at FROM public.notifications
    WHERE customer_user_id=$1 AND queue_ticket_id=$2 AND channel='MOCK_WHATSAPP' ORDER BY created_at DESC,id DESC LIMIT 50`,[userId,ticketId]);
  return rows.rows.map(r=>({id:r.id,type:r.type,title:r.title,message:r.message,status:r.status,recipientMasked:r.recipient_masked,failureCode:r.failure_code,createdAt:r.created_at.toISOString(),readAt:null}));
}
export async function markNotificationRead(client:PoolClient,userId:string,id:string):Promise<{readAt:string}>{
  const scope=(await client.query<QueueIds>(`SELECT t.business_id AS "businessId",t.branch_id AS "branchId",t.service_id AS "serviceId"
    FROM public.notifications n JOIN public.queue_tickets t ON t.id=n.queue_ticket_id
    WHERE n.id=$1 AND n.customer_user_id=$2 AND n.channel='IN_APP' AND n.status='SENT'`,[id,userId])).rows[0];
  if(!scope)throw missing();await lockQueueContext(client,scope);
  const updated=(await client.query(`UPDATE public.notifications SET read_at=clock_timestamp() WHERE id=$1 AND customer_user_id=$2 AND read_at IS NULL RETURNING queue_ticket_id,read_at`,[id,userId])).rows[0];
  if(updated){
    await client.query('UPDATE public.queue_sessions SET revision=revision+1 WHERE id=(SELECT queue_session_id FROM public.queue_tickets WHERE id=$1)',[updated.queue_ticket_id]);
    return {readAt:updated.read_at.toISOString()};
  }
  const row=(await client.query('SELECT read_at FROM public.notifications WHERE id=$1 AND customer_user_id=$2',[id,userId])).rows[0];
  return {readAt:row.read_at.toISOString()};
}
