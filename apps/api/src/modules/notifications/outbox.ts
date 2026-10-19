import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {TransactionRunner} from '../configuration/routes.js';
import type {NotificationDelivery,NotificationProvider} from './provider.js';
import {DeliveryError} from './meta-provider.js';

export const MAX_ATTEMPTS=5;
export const retryDelaySeconds=(attempt:number)=>Math.min(120,5*2**Math.max(0,attempt-1));
export interface Job {id:string;claim_token:string;attempts:number;notification_id:string;business_id:string;}
export interface Receipt {messageId:string;callbackId:string|null;status:'sent'|'delivered'|'read'|'failed';timestamp:string;code:string|null;hash:string;}

async function notificationState(c:PoolClient,job:Job,status:'SENT'|'FAILED'|'SKIPPED',code:string|null){
  await c.query(`UPDATE public.notifications SET status=$2::public.notification_status,
    sent_at=CASE WHEN $2='SENT' THEN coalesce(sent_at,clock_timestamp()) ELSE NULL END,failure_code=$3
    WHERE id=$1 AND business_id=$4 AND channel::text IN ('META_WHATSAPP','TWILIO_WHATSAPP')`,[job.notification_id,status,code,job.business_id]);
}

// Apply all known receipts monotonically, including receipts received before HTTP returned.
export async function reconcile(c:PoolClient,job:Job):Promise<boolean>{
  const out=(await c.query('SELECT * FROM public.whatsapp_outbox WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  const receipts=(await c.query(`SELECT * FROM public.whatsapp_receipts
    WHERE provider_message_id=$1 OR (callback_id=$2 AND ($1::text IS NULL OR provider_message_id=$1))
    ORDER BY CASE status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC,provider_timestamp DESC`,[out.provider_message_id,job.id])).rows;
  const receipt=receipts[0];if(!receipt)return false;
  const rank:Record<string,number>={sent:1,failed:2,delivered:3,read:4};
  if(out.delivery_status&&rank[out.delivery_status]!>rank[receipt.status]!)return true;
  await c.query(`UPDATE public.whatsapp_outbox SET provider_message_id=$2,delivery_status=$3,
    status=CASE WHEN $3='failed' THEN 'FAILED' ELSE 'ACCEPTED' END,error_code=$4,lease_until=NULL
    WHERE id=$1`,[job.id,receipt.provider_message_id,receipt.status,receipt.error_code]);
  await notificationState(c,job,receipt.status==='failed'?'FAILED':'SENT',receipt.error_code);
  return true;
}

export async function storeReceipts(c:PoolClient,receipts:Receipt[],channel='META_WHATSAPP'){
  // A stable order avoids multi-receipt webhook transactions deadlocking each other.
  for(const r of [...receipts].sort((a,b)=>a.messageId.localeCompare(b.messageId)||a.hash.localeCompare(b.hash))){
    await c.query(`INSERT INTO public.whatsapp_receipts(event_hash,provider_message_id,callback_id,status,provider_timestamp,error_code)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[r.hash,r.messageId,r.callbackId,r.status,r.timestamp,r.code]);
    const jobs=(await c.query<Job>(`SELECT id,business_id,notification_id FROM public.whatsapp_outbox
      WHERE (provider_message_id=$1 OR (id=$2 AND attempts>0 AND (provider_message_id IS NULL OR provider_message_id=$1)))
      AND notification_id IN (SELECT id FROM public.notifications WHERE channel::text=$3) ORDER BY id FOR UPDATE`,[r.messageId,r.callbackId,channel])).rows;
    for(const job of jobs)await reconcile(c,job);
  }
}

export class WhatsAppOutbox {
  constructor(private readonly run:TransactionRunner,private readonly provider:NotificationProvider,private readonly businessScope:string|null=null){}
  async claim():Promise<Job|null>{
    return this.run(async c=>{
      // Never retry an abandoned send: it might already have reached the recipient.
      await c.query(`UPDATE public.whatsapp_outbox SET status='AMBIGUOUS',error_code='WORKER_INTERRUPTED',lease_until=NULL
        WHERE status='SENDING' AND lease_until<clock_timestamp()
        AND ($2::uuid IS NULL OR business_id=$2)
        AND notification_id IN (SELECT id FROM public.notifications WHERE channel::text=$1)`,[this.provider.channel,this.businessScope]);
      const job=(await c.query<Job>(`SELECT id,business_id,notification_id,attempts FROM public.whatsapp_outbox
        WHERE status='READY' AND available_at<=clock_timestamp() AND attempts<$1
        AND ($3::uuid IS NULL OR business_id=$3)
        AND notification_id IN (SELECT id FROM public.notifications WHERE channel::text=$2)
        ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[MAX_ATTEMPTS,this.provider.channel,this.businessScope])).rows[0];
      if(!job)return null;
      job.claim_token=randomUUID();job.attempts++;
      await c.query(`UPDATE public.whatsapp_outbox SET status='SENDING',attempts=$2,claim_token=$3,
        lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1`,[job.id,job.attempts,job.claim_token]);
      return job;
    });
  }
  async prepare(job:Job):Promise<NotificationDelivery|null>{
    return this.run(async c=>{
      const row=(await c.query(`SELECT o.status AS job_status,o.claim_token,o.expires_at>clock_timestamp() AS fresh,
        n.type,n.title,n.message,n.source_event_id,t.status,t.prefix_snapshot,t.sequence_number,t.queue_order,
        j.phone_e164,j.whatsapp_opt_in_at,j.customer_name,br.name AS branch_name,
        b.is_active AND br.is_active AND sv.is_active AS active,s.status AS session_status,
        s.business_date=(clock_timestamp() AT TIME ZONE br.timezone)::date AS today,
        (SELECT count(*)::int FROM public.queue_tickets q WHERE q.queue_session_id=t.queue_session_id AND q.status='WAITING' AND q.queue_order<t.queue_order) AS people_ahead,
        (SELECT e.id FROM public.queue_events e WHERE e.queue_ticket_id=t.id AND e.event_type='TICKET_CALLED' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) AS latest_call
        FROM public.whatsapp_outbox o JOIN public.notifications n ON n.id=o.notification_id AND n.business_id=o.business_id
        JOIN public.queue_tickets t ON t.id=n.queue_ticket_id AND t.business_id=n.business_id AND t.customer_auth_id=n.customer_user_id
        JOIN public.join_requests j ON j.id=t.join_request_id JOIN public.queue_sessions s ON s.id=t.queue_session_id
        JOIN public.branches br ON br.id=t.branch_id JOIN public.businesses b ON b.id=t.business_id JOIN public.services sv ON sv.id=t.service_id
        WHERE o.id=$1 AND n.channel::text=$2 AND ($3::uuid IS NULL OR o.business_id=$3) FOR UPDATE OF o`,[job.id,this.provider.channel,this.businessScope])).rows[0];
      if(!row||row.job_status!=='SENDING'||row.claim_token!==job.claim_token)return null;
      const consent=Boolean(row.whatsapp_opt_in_at)&&/^\+628[0-9]{7,11}$/.test(row.phone_e164??'');
      const valid=row.fresh&&row.active&&row.today&&consent&&(
        row.type==='NEAR_TURN'?row.status==='WAITING'&&row.session_status==='OPEN'&&row.people_ahead<=3:
          row.type==='YOUR_TURN'&&row.status==='CALLED'&&row.latest_call===row.source_event_id);
      if(!valid){
        await c.query("UPDATE public.whatsapp_outbox SET status='SKIPPED',error_code='STALE_OR_NO_CONSENT',lease_until=NULL WHERE id=$1",[job.id]);
        await notificationState(c,job,'SKIPPED','STALE_OR_NO_CONSENT');return null;
      }
      return {title:row.title,message:row.message,phone:row.phone_e164,consented:true,dedupeKey:job.id,
        template:{type:row.type,branchName:row.branch_name,customerName:row.customer_name,
          queueNumber:row.prefix_snapshot+String(row.sequence_number).padStart(3,'0'),peopleAhead:row.people_ahead}};
    });
  }
  async tick():Promise<boolean>{
    const job=await this.claim();if(!job)return false;
    const delivery=await this.prepare(job);if(!delivery)return true;
    // Both claiming and eligibility transactions have COMMITTED before this call.
    let result;
    try{result=await this.provider.send(delivery);}
    catch(error){
      const failure=error instanceof DeliveryError?error:new DeliveryError('AMBIGUOUS','UNEXPECTED_SEND_ERROR');
      await this.run(async c=>{
        const locked=(await c.query('SELECT status,claim_token FROM public.whatsapp_outbox WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
        if(!locked||locked.claim_token!==job.claim_token||!['SENDING','AMBIGUOUS'].includes(locked.status))return;
        if(await reconcile(c,job))return;
        const next=failure.outcome==='RETRY'?(job.attempts<MAX_ATTEMPTS?'READY':'FAILED'):failure.outcome;
        await c.query(`UPDATE public.whatsapp_outbox SET status=$2,error_code=$3,lease_until=NULL,
          available_at=clock_timestamp()+make_interval(secs=>$4) WHERE id=$1`,[job.id,next,failure.code,retryDelaySeconds(job.attempts)]);
        if(next==='FAILED')await notificationState(c,job,'FAILED',failure.code);
      });return true;
    }
    await this.run(async c=>{
      const locked=(await c.query('SELECT status,claim_token FROM public.whatsapp_outbox WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if(!locked||locked.claim_token!==job.claim_token||!['SENDING','AMBIGUOUS'].includes(locked.status))return;
      if(result.status==='SKIPPED'){
        await c.query("UPDATE public.whatsapp_outbox SET status='SKIPPED',error_code=$2,lease_until=NULL WHERE id=$1",[job.id,result.code??'PROVIDER_SKIPPED']);
        await notificationState(c,job,'SKIPPED',result.code??'PROVIDER_SKIPPED');return;
      }
      if(!result.providerMessageId)throw new Error('Provider acceptance requires a message ID.');
      await c.query("UPDATE public.whatsapp_outbox SET status='ACCEPTED',provider_message_id=$2,error_code=NULL,lease_until=NULL WHERE id=$1",[job.id,result.providerMessageId]);
      await notificationState(c,job,'SENT',null);
      await reconcile(c,job);
    });return true;
  }
}
