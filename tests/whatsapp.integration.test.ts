import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {WhatsAppOutbox,storeReceipts,type Receipt} from '../apps/api/src/modules/notifications/outbox.js';
import {DeliveryError} from '../apps/api/src/modules/notifications/meta-provider.js';
import type {NotificationProvider} from '../apps/api/src/modules/notifications/provider.js';

// Requires a dedicated, already migrated Supabase-compatible TEST database.
// Never reads .env, runs migrations, or contacts Meta. All sends use injected fakes.
test('WhatsApp durable outbox PostgreSQL concurrency and failure isolation',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 Object.assign(process.env,{NODE_ENV:'test',WHATSAPP_PROVIDER:'META',META_WHATSAPP_ACCESS_TOKEN:'fixture-token',
  META_WHATSAPP_PHONE_NUMBER_ID:'123456',META_WHATSAPP_API_VERSION:'v25.0',META_WHATSAPP_APP_SECRET:'fixture-secret',
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:'fixture-verify',META_WHATSAPP_NEAR_TURN_TEMPLATE:'fixture_near',META_WHATSAPP_YOUR_TURN_TEMPLATE:'fixture_called',META_WHATSAPP_TEMPLATE_LANGUAGE:'id'});
 const {NotificationService}=await import('../apps/api/src/modules/notifications/service.js');
 const {lockQueueContext}=await import('../apps/api/src/modules/queues/context.js');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,connectionTimeoutMillis:10000});
 const businessId=randomUUID(),branchId=randomUUID(),serviceId=randomUUID(),owner=randomUUID(),sessionId=randomUUID();
 const scope={businessId,branchId,serviceId},users=[owner],messageIds:string[]=[];
 const service=new NotificationService();let sequence=0,sends=0;
 async function run<T>(fn:(c:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 const provider:NotificationProvider={channel:'META_WHATSAPP',send:async()=>{sends++;const id='wamid.'+randomUUID();messageIds.push(id);return {status:'SENT',providerMessageId:id};}};
 const worker=()=>new WhatsAppOutbox(run,provider,businessId);
 async function reset(){await pool.query('DELETE FROM public.notifications WHERE business_id=$1',[businessId]);await pool.query("UPDATE public.queue_tickets SET status='CANCELLED',cancelled_at=clock_timestamp(),counter_id=NULL WHERE business_id=$1",[businessId]);sends=0;}
 async function ticket(consent=true,called=false){
  return run(async c=>{
   const user=randomUUID(),request=randomUUID(),id=randomUUID(),counter=randomUUID();users.push(user);sequence++;
   await c.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,true)',[user]);
   await c.query("INSERT INTO public.join_requests(id,business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,phone_e164,whatsapp_opt_in_at,status,payment_mode_snapshot,price_snapshot,amount_due,expires_at,admitted_at) VALUES($1,$2,$3,$4,$5,$6,'Test customer','+6281234567890',CASE WHEN $7 THEN clock_timestamp() END,'ADMITTED','NONE',0,0,clock_timestamp()+interval '30 minutes',clock_timestamp())",[request,businessId,branchId,serviceId,sessionId,user,consent]);
   if(called)await c.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,$5)",[counter,businessId,branchId,serviceId,'Counter '+sequence]);
   await c.query("INSERT INTO public.queue_tickets(id,business_id,branch_id,service_id,queue_session_id,join_request_id,customer_auth_id,sequence_number,prefix_snapshot,queue_order,status,counter_id,called_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'W',$8,$9,$10,CASE WHEN $11 THEN clock_timestamp() END)",[id,businessId,branchId,serviceId,sessionId,request,user,sequence,called?'CALLED':'WAITING',called?counter:null,called]);
   const event=(await c.query("INSERT INTO public.queue_events(business_id,queue_session_id,queue_ticket_id,event_type,actor_type) VALUES($1,$2,$3,$4,'SYSTEM') RETURNING id",[businessId,sessionId,id,called?'TICKET_CALLED':'TICKET_ADMITTED'])).rows[0];
   const context=await lockQueueContext(c,scope),e={id:event.id,name:called?'TICKET_CALLED':'TICKET_ADMITTED',ticketId:id,sessionId};
   await service.handleQueueEvent(c,context,e);await service.handleQueueEvent(c,context,e);
   return {id,request,event:e};
  });
 }
 const jobs=async()=>(await pool.query('SELECT * FROM public.whatsapp_outbox WHERE business_id=$1',[businessId])).rows;
 const receipt=(id:string,callback:string,status:Receipt['status']):Receipt=>({messageId:id,callbackId:callback,status,timestamp:'1800000000',code:status==='failed'?'META_131026':null,hash:createHash('sha256').update(id+status).digest('hex')});
 try{
  await run(async c=>{
   await c.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,false)',[owner]);
   await c.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Outbox owner')",[owner]);
   await c.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Outbox test',$2,$3)",[businessId,'wa-'+businessId,owner]);
   await c.query("INSERT INTO public.branches(id,business_id,name,public_slug) VALUES($1,$2,'Outbox branch',$3)",[branchId,businessId,'wa-'+branchId]);
   await c.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix) VALUES($1,$2,$3,'Queue',0,10,'W')",[serviceId,businessId,branchId]);
   await c.query("INSERT INTO public.queue_sessions(id,business_id,branch_id,service_id,business_date) VALUES($1,$2,$3,$4,(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date)",[sessionId,businessId,branchId,serviceId]);
  });
  await t.test('atomic intent generation, duplicate event suppression and consent',async()=>{
   await reset();await ticket(false);assert.equal((await jobs()).length,0);
   const customer=await ticket();assert.equal((await jobs()).length,1);assert.equal(sends,0);
   assert.ok((await pool.query("SELECT 1 FROM public.notifications WHERE business_id=$1 AND channel='IN_APP' AND status='SENT'",[businessId])).rowCount);
   await pool.query('DELETE FROM public.notifications WHERE business_id=$1',[businessId]);
   const c=await pool.connect();try{
    await c.query('BEGIN');const context=await lockQueueContext(c,scope);
    await service.handleQueueEvent(c,context,customer.event);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM public.whatsapp_outbox WHERE business_id=$1',[businessId])).rows[0].n,1);
    await c.query('ROLLBACK');assert.equal((await jobs()).length,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notifications WHERE business_id=$1',[businessId])).rows[0].n,0);
   }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
  });
  await t.test('concurrent workers claim disjoint work and send once',async()=>{
   await reset();await ticket();await Promise.all([worker().tick(),worker().tick()]);assert.equal(sends,1);assert.equal((await jobs())[0].status,'ACCEPTED');
  });
  await t.test('retry backoff and bounded attempts preserve the ticket',async()=>{
   await reset();const customer=await ticket();
   const throttled=new WhatsAppOutbox(run,{channel:'META_WHATSAPP',send:async()=>{throw new DeliveryError('RETRY','META_RATE_LIMIT');}},businessId);
   for(let i=1;i<=5;i++){await throttled.tick();const job=(await jobs())[0];assert.equal(job.attempts,i);assert.equal(job.status,i<5?'READY':'FAILED');if(i<5){assert.ok(new Date(job.available_at).getTime()>Date.now());await pool.query("UPDATE public.whatsapp_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);}}
   assert.equal((await pool.query('SELECT status FROM public.queue_tickets WHERE id=$1',[customer.id])).rows[0].status,'WAITING');
  });
  await t.test('ambiguous sends and expired worker leases are never automatically resent',async()=>{
   await reset();await ticket();let count=0;
   const uncertain=new WhatsAppOutbox(run,{channel:'META_WHATSAPP',send:async()=>{count++;throw new DeliveryError('AMBIGUOUS','TRANSPORT_UNCERTAIN');}},businessId);
   await uncertain.tick();await uncertain.tick();assert.equal(count,1);assert.equal((await jobs())[0].status,'AMBIGUOUS');
   await reset();await ticket();const w=worker(),job=await w.claim();assert.ok(job);
   await pool.query("UPDATE public.whatsapp_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
   assert.equal(await w.claim(),null);assert.equal((await jobs())[0].status,'AMBIGUOUS');assert.equal(sends,0);
  });
  await t.test('stale near-turn, removed consent and old call events are suppressed',async()=>{
   for(const reason of ['completed','consent','expired']){
    await reset();const customer=await ticket();
    if(reason==='completed')await pool.query("UPDATE public.queue_tickets SET status='COMPLETED',completed_at=clock_timestamp() WHERE id=$1",[customer.id]);
    if(reason==='consent')await pool.query('UPDATE public.join_requests SET whatsapp_opt_in_at=NULL WHERE id=$1',[customer.request]);
    if(reason==='expired')await pool.query("UPDATE public.whatsapp_outbox SET expires_at=clock_timestamp()-interval '1 second' WHERE business_id=$1",[businessId]);
    await worker().tick();assert.equal(sends,0);assert.equal((await jobs())[0].status,'SKIPPED');
   }
   await reset();const customer=await ticket(true,true);
   await pool.query("INSERT INTO public.queue_events(business_id,queue_session_id,queue_ticket_id,event_type,actor_type,occurred_at) VALUES($1,$2,$3,'TICKET_CALLED','SYSTEM',clock_timestamp()+interval '1 second')",[businessId,sessionId,customer.id]);
   await worker().tick();assert.equal(sends,0);assert.equal((await jobs())[0].status,'SKIPPED');
  });
  await t.test('early callbacks reconcile ambiguous HTTP outcomes, duplicates and out-of-order receipts',async()=>{
   await reset();await ticket(true,true);const message='wamid.'+randomUUID();messageIds.push(message);
   const early=new WhatsAppOutbox(run,{channel:'META_WHATSAPP',send:async d=>{
    const r=receipt(message,d.dedupeKey,'delivered');await run(c=>storeReceipts(c,[r,r]));throw new DeliveryError('AMBIGUOUS','TRANSPORT_UNCERTAIN');}},businessId);
   await early.tick();let job=(await jobs())[0];assert.equal(job.status,'ACCEPTED');assert.equal(job.delivery_status,'delivered');
   await run(c=>storeReceipts(c,[receipt(message,job.id,'read'),receipt(message,job.id,'sent'),receipt(message,job.id,'failed')]));
   job=(await jobs())[0];assert.equal(job.delivery_status,'read');assert.equal(job.status,'ACCEPTED');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.whatsapp_receipts WHERE provider_message_id=$1',[message])).rows[0].n,4);
  });
  await t.test('browser roles cannot read delivery records or receipt inbox',async()=>{
   const c=await pool.connect();try{for(const table of ['whatsapp_outbox','whatsapp_receipts']){await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');await assert.rejects(c.query('SELECT * FROM public.'+table),{code:'42501'});await c.query('ROLLBACK');}}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
  });
 }finally{
  try{await run(async c=>{
   await c.query('DELETE FROM public.whatsapp_receipts WHERE provider_message_id=ANY($1::text[])',[messageIds]);
   for(const table of ['queue_events','queue_tickets','join_requests','queue_sessions','service_counters','services','branches','businesses'])await c.query('DELETE FROM public.'+table+' WHERE '+(table==='businesses'?'id':'business_id')+'=$1',[businessId]);
   await c.query('DELETE FROM public.profiles WHERE user_id=$1',[owner]);await c.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[users]);
  });}finally{await pool.end();}
 }
});
