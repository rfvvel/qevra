import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {CheckoutDto,PaymentAttemptDto,CustomerJoinData,CustomerJoinResult,PaymentStatus,PaymentMode,MockPaymentOutcome} from '@qevra/contracts';
import {lockQueueContext,conflict,type QueueContext,type QueueIds} from '../queues/context.js';
import {session,type Session} from '../queues/engine.js';
import {admitJoinRequest} from '../queues/admission.js';
import {idempotentCommand} from '../queues/idempotency.js';
import {missing} from '../configuration/access.js';
import {HttpError} from '../../shared/http-error.js';
import {mockPaymentProvider,type PaymentProvider,type VerifiedPaymentEvent} from './provider.js';
interface JoinRow {
  id:string;business_id:string;branch_id:string;service_id:string;queue_session_id:string;customer_auth_id:string;
  status:string;payment_mode_snapshot:PaymentMode;price_snapshot:string;amount_due:string;currency:'IDR';
  expires_at:Date;unexpired:boolean;reconciliation_reason:string|null;
}
interface PaymentRow {
  id:string;business_id:string;join_request_id:string;provider:string;provider_reference:string;status:PaymentStatus;
  amount:string;currency:'IDR';paid_at:Date|null;expires_at:Date;created_at:Date;is_settlement:boolean;
}
interface LockedCheckout {request:JoinRow;context:QueueContext;current:Session;payments:PaymentRow[];}
const scopeOf=(r:JoinRow):QueueIds=>({businessId:r.business_id,branchId:r.branch_id,serviceId:r.service_id});
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function paymentEvent(client:PoolClient,payment:PaymentRow,eventId:string,type:string,from:string|null,to:string,hash:string,actorId:string|null,metadata:Record<string,unknown>={}){
  await client.query(`INSERT INTO public.payment_events(business_id,join_request_id,payment_id,provider,provider_event_id,event_type,payload_hash,from_status,to_status,actor_user_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[payment.business_id,payment.join_request_id,payment.id,payment.provider,eventId,type,hash,from,to,actorId,JSON.stringify(metadata)]);
}
async function readRequest(client:PoolClient,id:string,userId?:string):Promise<JoinRow>{
  const row=(await client.query<JoinRow>('SELECT *,expires_at>clock_timestamp() AS unexpired FROM public.join_requests WHERE id=$1'+(userId?' AND customer_auth_id=$2':''),userId?[id,userId]:[id])).rows[0];
  if(!row)throw missing();return row;
}
async function lockCheckout(client:PoolClient,id:string,userId?:string):Promise<LockedCheckout>{
  const ref=await readRequest(client,id,userId);
  const context=await lockQueueContext(client,scopeOf(ref));
  const current=(await session(client,context,ref.queue_session_id))!;
  const request=(await client.query<JoinRow>('SELECT *,expires_at>clock_timestamp() AS unexpired FROM public.join_requests WHERE id=$1 FOR UPDATE',[id])).rows[0]!;
  const payments=(await client.query<PaymentRow>('SELECT * FROM public.payments WHERE join_request_id=$1 ORDER BY created_at,id FOR UPDATE',[id])).rows;
  return {request,context,current,payments};
}
function eligible(checkout:LockedCheckout):boolean{
  const {request:r,context:c,current:s}=checkout;
  return r.status==='PAYMENT_PENDING'&&r.unexpired&&c.businessActive&&c.branchActive&&c.serviceActive&&s.status==='OPEN'&&s.business_date===c.businessDate;
}
async function expirePending(client:PoolClient,checkout:LockedCheckout){
  const expired=(await client.query<PaymentRow>(`UPDATE public.payments SET status='EXPIRED',failure_code='TIMEOUT'
    WHERE join_request_id=$1 AND status='PENDING' AND (expires_at<=clock_timestamp() OR $2::boolean) RETURNING *`,[checkout.request.id,!checkout.request.unexpired])).rows;
  for(const payment of expired)await paymentEvent(client,payment,'timeout:'+payment.id,'ATTEMPT_EXPIRED','PENDING','EXPIRED',fingerprint(['timeout',payment.id]),null);
  if(!checkout.request.unexpired&&checkout.request.status==='PAYMENT_PENDING')await client.query("UPDATE public.join_requests SET status='EXPIRED' WHERE id=$1",[checkout.request.id]);
}
async function newAttempt(client:PoolClient,request:JoinRow,provider:PaymentProvider):Promise<PaymentRow>{
  const id=randomUUID(),expiresAt=new Date(Math.min(Date.now()+5*60000,request.expires_at.getTime()));
  const checkout=await provider.createCheckout({id,amount:request.amount_due,currency:request.currency,expiresAt});
  const payment=(await client.query<PaymentRow>(`INSERT INTO public.payments(id,business_id,join_request_id,provider,provider_reference,amount,currency,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,request.business_id,request.id,provider.name,checkout.reference,request.amount_due,request.currency,expiresAt])).rows[0]!;
  await paymentEvent(client,payment,'created:'+id,'CHECKOUT_CREATED',null,'PENDING',fingerprint(['created',id]),request.customer_auth_id);
  return payment;
}
export class PaymentService {
  constructor(private readonly provider:PaymentProvider=mockPaymentProvider){}
  async existingCheckout(client:PoolClient,userId:string,context:QueueContext):Promise<CustomerJoinResult|null>{
    const existing=(await client.query<JoinRow>(`SELECT *,expires_at>clock_timestamp() AS unexpired FROM public.join_requests
      WHERE customer_auth_id=$1 AND service_id=$2 AND status IN ('PAYMENT_PENDING','RECONCILIATION_REQUIRED') ORDER BY created_at DESC LIMIT 1`,[userId,context.serviceId])).rows[0];
    if(!existing)return null;
    if(existing.status==='PAYMENT_PENDING'&&!existing.unexpired){
      await expirePending(client,await lockCheckout(client,existing.id,userId));return null;
    }
    const value=(await session(client,context,existing.queue_session_id))!;
    return {outcome:'PAYMENT_REQUIRED',joinRequestId:existing.id,ticketId:null,sessionId:value.id,revision:value.revision};
  }
  async createJoin(client:PoolClient,userId:string,context:QueueContext,current:Session,data:CustomerJoinData):Promise<CustomerJoinResult>{
    const configuration=(await client.query<{deposit_amount:string|null}>('SELECT deposit_amount FROM public.services WHERE id=$1',[context.serviceId])).rows[0]!;
    const amount=context.paymentMode==='DEPOSIT'?configuration.deposit_amount:context.price;
    if(!amount||BigInt(amount)<=0n)throw conflict('Payment configuration is unavailable.','PAYMENT_UNAVAILABLE');
    const request=(await client.query<JoinRow>(`INSERT INTO public.join_requests(business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,phone_e164,whatsapp_opt_in_at,status,payment_mode_snapshot,price_snapshot,amount_due,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $11::boolean THEN clock_timestamp() ELSE NULL END,'PAYMENT_PENDING',$8,$9,$10,clock_timestamp()+interval '30 minutes') RETURNING *,true AS unexpired`,
      [context.businessId,context.branchId,context.serviceId,current.id,userId,data.customerName,data.phone??null,context.paymentMode,context.price,amount,data.whatsappOptIn])).rows[0]!;
    await newAttempt(client,request,this.provider);
    return {outcome:'PAYMENT_REQUIRED',joinRequestId:request.id,ticketId:null,sessionId:current.id,revision:current.revision};
  }
  async checkout(client:PoolClient,userId:string,id:string,enabled:boolean):Promise<CheckoutDto>{
    let locked=await lockCheckout(client,id,userId);
    if(!locked.payments.length)throw missing();
    await expirePending(client,locked);
    locked=await lockCheckout(client,id,userId);
    const r=locked.request,payments=locked.payments;
    const payment=payments.find(value=>value.is_settlement)??payments[payments.length-1]!;
    const ticket=(await client.query<{id:string}>('SELECT id FROM public.queue_tickets WHERE join_request_id=$1',[id])).rows[0];
    const labels=(await client.query<{name:string;public_slug:string}>('SELECT name,public_slug FROM public.branches WHERE id=$1',[r.branch_id])).rows[0]!;
    const dto=(p:PaymentRow):PaymentAttemptDto=>({id:p.id,provider:p.provider,status:p.status,amount:p.amount,currency:p.currency,paidAt:p.paid_at?.toISOString()??null,expiresAt:p.expires_at.toISOString(),createdAt:p.created_at.toISOString()});
    const active=(await client.query("SELECT 1 FROM public.queue_tickets WHERE service_id=$1 AND customer_auth_id=$2 AND status IN ('WAITING','CALLED','SERVING')",[r.service_id,userId])).rowCount;
    return {joinRequest:{id:r.id,status:r.status,expiresAt:r.expires_at.toISOString()},
      service:{name:locked.context.serviceName,branchName:labels.name,branchSlug:labels.public_slug},
      pricing:{mode:r.payment_mode_snapshot,servicePrice:r.price_snapshot,payNow:r.amount_due,remaining:(BigInt(r.price_snapshot)-BigInt(r.amount_due)).toString(),currency:r.currency},
      payment:dto(payment),attempts:payments.map(dto),ticketId:ticket?.id??null,
      canRetry:enabled&&eligible(locked)&&!active&&!payments.some(value=>value.is_settlement||value.status==='PENDING'),
      mockControlsEnabled:enabled&&payment.provider==='MOCK',generatedAt:new Date().toISOString()};
  }
  async retry(client:PoolClient,userId:string,id:string,key:string,enabled:boolean):Promise<CheckoutDto>{
    const ref=await readRequest(client,id,userId),scope=scopeOf(ref);
    await client.query('SELECT id FROM public.businesses WHERE id=$1 FOR SHARE',[scope.businessId]);
    await idempotentCommand(client,scope,userId,key,'payment/retry/'+id,{},async()=>{
      let locked=await lockCheckout(client,id,userId);await expirePending(client,locked);locked=await lockCheckout(client,id,userId);
      if(!enabled||!eligible(locked)||locked.payments.some(value=>value.is_settlement))throw conflict('A new payment cannot be created for this checkout.','CHECKOUT_UNAVAILABLE');
      const pending=locked.payments.find(value=>value.status==='PENDING');
      if(pending)return {paymentId:pending.id};
      if((await client.query("SELECT 1 FROM public.queue_tickets WHERE service_id=$1 AND customer_auth_id=$2 AND status IN ('WAITING','CALLED','SERVING')",[scope.serviceId,userId])).rowCount)throw conflict('You already have an active ticket.','ACTIVE_TICKET_EXISTS');
      return {paymentId:(await newAttempt(client,locked.request,this.provider)).id};
    });
    return this.checkout(client,userId,id,enabled);
  }
  // Provider verification is the single entry point for both mock notifications
  // and future signed webhooks. No client "paid=true" flag enters admission.
  async confirm(client:PoolClient,notification:unknown):Promise<string>{
    const verified=await this.provider.verifyNotification(notification);
    const ref=(await client.query<PaymentRow>('SELECT * FROM public.payments WHERE provider=$1 AND provider_reference=$2',[verified.provider,verified.reference])).rows[0];
    if(!ref)throw missing();
    const locked=await lockCheckout(client,ref.join_request_id),r=locked.request;
    const payment=locked.payments.find(value=>value.id===ref.id)!;
    if(payment.amount!==verified.amount||payment.currency!==verified.currency)throw conflict('Payment amount or currency did not match.','PAYMENT_MISMATCH');
    const hash=fingerprint([verified.provider,verified.reference,verified.eventId,verified.outcome,verified.amount,verified.currency]);
    const existing=(await client.query<{payload_hash:string}>('SELECT payload_hash FROM public.payment_events WHERE provider=$1 AND provider_event_id=$2',[verified.provider,verified.eventId])).rows[0];
    if(existing){if(existing.payload_hash!==hash)throw conflict('Payment event was already used.','PAYMENT_EVENT_CONFLICT');return r.id;}
    if(verified.outcome==='SUCCESS')await this.success(client,locked,payment,verified,hash);
    else{
      const target=payment.status==='PENDING'?(verified.outcome==='FAILURE'?'FAILED':'EXPIRED'):payment.status;
      if(payment.status==='PENDING')await client.query('UPDATE public.payments SET status=$2,failure_code=$3 WHERE id=$1',[payment.id,target,verified.outcome==='FAILURE'?'PROVIDER_DECLINED':'PROVIDER_EXPIRED']);
      await paymentEvent(client,payment,verified.eventId,'PROVIDER_'+verified.outcome,payment.status,target,hash,r.customer_auth_id);
    }
    return r.id;
  }
  private async success(client:PoolClient,locked:LockedCheckout,payment:PaymentRow,verified:VerifiedPaymentEvent,hash:string){
    const r=locked.request;
    if(payment.status==='PAID'||payment.status==='REFUNDED'){
      await paymentEvent(client,payment,verified.eventId,'DUPLICATE_SUCCESS',payment.status,payment.status,hash,r.customer_auth_id);return;
    }
    const settlement=locked.payments.find(value=>value.is_settlement);
    await client.query("UPDATE public.payments SET status='PAID',paid_at=clock_timestamp(),failure_code=NULL,is_settlement=$2 WHERE id=$1",[payment.id,!settlement]);
    await paymentEvent(client,payment,verified.eventId,'PROVIDER_SUCCESS',payment.status,'PAID',hash,r.customer_auth_id);
    if(settlement){
      await client.query("UPDATE public.payments SET reconciliation_reason='DUPLICATE_PAYMENT' WHERE id=$1",[payment.id]);return;
    }
    // Retain all earlier attempts; end other in-flight mock attempts without
    // claiming that a future real gateway has cancelled an external payment.
    const superseded=(await client.query<PaymentRow>("UPDATE public.payments SET status='EXPIRED',failure_code='SUPERSEDED' WHERE join_request_id=$1 AND id<>$2 AND status='PENDING' RETURNING *",[r.id,payment.id])).rows;
    for(const attempt of superseded)await paymentEvent(client,attempt,'superseded:'+attempt.id,'ATTEMPT_SUPERSEDED','PENDING','EXPIRED',fingerprint(['superseded',attempt.id]),null);
    await client.query('SAVEPOINT paid_admission');
    try{
      await admitJoinRequest(client,scopeOf(r),{userId:r.customer_auth_id,type:'CUSTOMER'},r.id);
      await client.query('RELEASE SAVEPOINT paid_admission');
    }catch(error){
      await client.query('ROLLBACK TO SAVEPOINT paid_admission');await client.query('RELEASE SAVEPOINT paid_admission');
      const reason=!r.unexpired?'REQUEST_EXPIRED':error instanceof HttpError?error.code:'ADMISSION_ERROR';
      await client.query("UPDATE public.join_requests SET status='RECONCILIATION_REQUIRED',reconciliation_reason=$2 WHERE id=$1",[r.id,reason]);
      await client.query('UPDATE public.payments SET reconciliation_reason=$2 WHERE id=$1',[payment.id,reason]);
      await paymentEvent(client,payment,'reconcile:'+payment.id,'RECONCILIATION_REQUIRED','PAID','PAID',fingerprint(['reconcile',payment.id,reason]),null,{reason});
    }
  }
  async mockConfirm(client:PoolClient,userId:string,paymentId:string,key:string,outcome:MockPaymentOutcome,enabled:boolean):Promise<CheckoutDto>{
    if(!enabled||this.provider!==mockPaymentProvider)throw missing();
    const row=(await client.query<PaymentRow>(`SELECT p.* FROM public.payments p JOIN public.join_requests j ON j.id=p.join_request_id
      WHERE p.id=$1 AND j.customer_auth_id=$2`,[paymentId,userId])).rows[0];
    if(!row||row.provider!=='MOCK')throw missing();
    const notification=mockPaymentProvider.simulate({reference:row.provider_reference,eventId:'mock:'+row.id+':'+key,outcome,amount:row.amount,currency:row.currency});
    const requestId=await this.confirm(client,notification);
    return this.checkout(client,userId,requestId,enabled);
  }
}
export const paymentService=new PaymentService();
