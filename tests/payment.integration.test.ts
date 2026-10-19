import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import type {CheckoutDto,CustomerJoinResult,PaymentMode} from '@qevra/contracts';
test('Phase 5 payment admission and concurrent PostgreSQL transactions',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  process.env.NODE_ENV='test';process.env.PAYMENT_PROVIDER='MOCK';
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='test-public-key';
  const {createApp}=await import('../apps/api/src/app.js');
  const {getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
  const {admitJoinRequest}=await import('../apps/api/src/modules/queues/admission.js');
  const {paymentService}=await import('../apps/api/src/modules/payments/service.js');
  const {mockPaymentProvider}=await import('../apps/api/src/modules/payments/provider.js');
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,connectionTimeoutMillis:15000});
  const owner=randomUUID(),a=randomUUID(),b=randomUUID(),users=[owner,a,b],biz=randomUUID(),branch=randomUUID(),slug='payments-'+branch;
  const auth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>users.includes(token)?{data:{user:{id:token,is_anonymous:token!==owner}},error:null}:{data:{user:null},error:new Error('Invalid')});
  async function run<T>(operation:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
    const client=await pool.connect();try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const server=createApp({runTransaction:run}).listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1/customer';
  async function api<T=CheckoutDto>(path:string,body?:unknown,status=200,user=a,key=randomUUID()):Promise<T>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status,path);return await response.json() as T;
  }
  let serviceIndex=0;
  async function create(mode:PaymentMode='FULL'){
    const service=randomUUID();
    await run(async client=>{
      await client.query(`INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode,deposit_amount)
        VALUES($1,$2,$3,'Payment test',500000,30,$4,$5,$6)`,[service,biz,branch,'P'+String.fromCharCode(65+serviceIndex++),mode,mode==='DEPOSIT'?50000:null]);
      await client.query(`INSERT INTO public.queue_sessions(business_id,branch_id,service_id,business_date) VALUES($1,$2,$3,(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date)`,[biz,branch,service]);
    });return service;
  }
  const join=(service:string,body:Record<string,unknown>={},status=200)=>api<CustomerJoinResult>('/join-requests',{branchSlug:slug,serviceId:service,customerName:'Payment customer',...body},status);
  async function begin(mode:PaymentMode='FULL'){
    const service=await create(mode),joined=await join(service);assert.equal(joined.ticketId,null);assert.ok(joined.outcome==='PAYMENT_REQUIRED');
    const checkout=await api('/join-requests/'+joined.joinRequestId);
    return {service,id:joined.joinRequestId!,checkout};
  }
  const confirm=(p:string,outcome='SUCCESS',status=200,user=a,key=randomUUID())=>api('/payments/'+p+'/mock',{outcome},status,user,key);
  const retry=(id:string,key=randomUUID())=>api('/join-requests/'+id+'/payments',{},200,a,key);
  async function ticketCount(id:string){return (await pool.query('SELECT count(*)::int AS n FROM public.queue_tickets WHERE join_request_id=$1',[id])).rows[0].n;}
  try{
    await run(async client=>{
      for(const user of users)await client.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,$2)',[user,user!==owner]);
      await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Payment owner')",[owner]);
      await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Payment test',$2,$3)",[biz,'payments-'+biz,owner]);
      await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[biz,owner]);
      await client.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,'Payment branch',$3,'Asia/Jakarta')",[branch,biz,slug]);
    });
    await t.test('NONE retains immediate admission without a payment',async()=>{
      const result=await join(await create('NONE'));assert.ok(result.ticketId);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.payments WHERE business_id=$1',[biz])).rows[0].n,0);
    });
    for(const mode of ['DEPOSIT','FULL'] as const)await t.test(mode+' snapshots integer IDR and requires verified settlement',async()=>{
      const {service,id,checkout}=await begin(mode);
      assert.equal(checkout.payment.status,'PENDING');assert.equal(checkout.pricing.payNow,mode==='DEPOSIT'?'50000':'500000');
      assert.equal(checkout.pricing.remaining,mode==='DEPOSIT'?'450000':'0');assert.equal(checkout.pricing.currency,'IDR');assert.equal(await ticketCount(id),0);
      await assert.rejects(run(client=>admitJoinRequest(client,{businessId:biz,branchId:branch,serviceId:service},{userId:a,type:'CUSTOMER'},id)),{code:'PAYMENT_REQUIRED'});
      await assert.rejects(pool.query(`INSERT INTO public.queue_tickets(business_id,branch_id,service_id,queue_session_id,join_request_id,customer_auth_id,sequence_number,prefix_snapshot,queue_order)
        SELECT business_id,branch_id,service_id,queue_session_id,id,customer_auth_id,1,'T',1 FROM public.join_requests WHERE id=$1`,[id]),{code:'23514'});
      const paid=await confirm(checkout.payment.id);assert.equal(paid.payment.status,'PAID');assert.ok(paid.payment.paidAt);assert.equal(paid.joinRequest.status,'ADMITTED');assert.ok(paid.ticketId);
      assert.equal(await ticketCount(id),1);
    });
    await t.test('price and mode changes do not change an existing deposit snapshot',async()=>{
      const {service,id,checkout}=await begin('DEPOSIT');
      await pool.query("UPDATE public.services SET price_amount=900000,payment_mode='FULL',deposit_amount=NULL WHERE id=$1",[service]);
      const fresh=await api('/join-requests/'+id);assert.equal(fresh.pricing.mode,'DEPOSIT');assert.equal(fresh.pricing.servicePrice,'500000');assert.equal(fresh.pricing.payNow,'50000');
      assert.equal((await confirm(checkout.payment.id)).joinRequest.status,'ADMITTED');
    });
    await t.test('failed and expired attempts remain immutable history; retries create new attempts',async()=>{
      const {id,checkout}=await begin();
      const failed=await confirm(checkout.payment.id,'FAILURE');assert.equal(failed.payment.status,'FAILED');assert.equal(failed.canRetry,true);assert.equal(await ticketCount(id),0);
      const key=randomUUID(),[second,repeat]=await Promise.all([retry(id,key),retry(id,key)]);
      assert.equal(second.payment.id,repeat.payment.id);assert.notEqual(second.payment.id,checkout.payment.id);
      assert.equal((await confirm(second.payment.id,'EXPIRY')).payment.status,'EXPIRED');assert.equal(await ticketCount(id),0);
      const third=await retry(id);assert.notEqual(third.payment.id,second.payment.id);
      const paid=await confirm(third.payment.id);assert.deepEqual(paid.attempts.map(p=>p.status),['FAILED','EXPIRED','PAID']);assert.equal(await ticketCount(id),1);
      const late=await confirm(checkout.payment.id);assert.equal(late.ticketId,paid.ticketId);
      const rows=(await pool.query('SELECT status,is_settlement,reconciliation_reason FROM public.payments WHERE join_request_id=$1',[id])).rows;
      assert.equal(rows.filter(p=>p.is_settlement).length,1);assert.equal(rows.filter(p=>p.reconciliation_reason==='DUPLICATE_PAYMENT').length,1);assert.equal(await ticketCount(id),1);
    });
    await t.test('concurrent confirmations and callback replay create one settlement and one ticket',async()=>{
      const {id,checkout}=await begin(),key=randomUUID();
      const results=await Promise.all(Array.from({length:6},(_,i)=>confirm(checkout.payment.id,'SUCCESS',200,a,i<3?key:randomUUID())));
      assert.ok(results.every(value=>value.ticketId===results[0].ticketId));assert.equal(await ticketCount(id),1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.payments WHERE join_request_id=$1 AND is_settlement',[id])).rows[0].n,1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.payment_events WHERE payment_id=$1 AND event_type='PROVIDER_SUCCESS'",[checkout.payment.id])).rows[0].n,1);
      await confirm(checkout.payment.id,'FAILURE',409,a,key);
      assert.equal((await confirm(checkout.payment.id,'FAILURE')).payment.status,'PAID');
      assert.equal(await ticketCount(id),1);
    });
    await t.test('ownership, strict input, and provider amount validation reject forgery',async()=>{
      const {service,id,checkout}=await begin();
      await api('/join-requests/'+id,undefined,404,b);await confirm(checkout.payment.id,'SUCCESS',404,b);
      await api('/join-requests/'+id+'/payments',{},404,b);await api('/join-requests/'+id,undefined,403,owner);
      for(const extra of [{price:1},{amount_due:1},{paymentMode:'NONE'},{currency:'USD'},{businessId:biz}])await join(service,extra,400);
      await api('/payments/'+checkout.payment.id+'/mock',{outcome:'SUCCESS',amount:1},400);
      const reference=(await pool.query('SELECT provider_reference FROM public.payments WHERE id=$1',[checkout.payment.id])).rows[0].provider_reference;
      const notification=mockPaymentProvider.simulate({reference,eventId:randomUUID(),outcome:'SUCCESS',amount:'1',currency:'IDR'});
      await assert.rejects(run(client=>paymentService.confirm(client,notification)),{code:'PAYMENT_MISMATCH'});
      assert.equal(await ticketCount(id),0);
      assert.equal((await api('/join-requests/'+id)).payment.status,'PENDING');
    });
    for(const condition of ['PAUSED','CLOSED','SERVICE_INACTIVE','BRANCH_INACTIVE','BUSINESS_INACTIVE','EXPIRED'] as const)await t.test('successful payment retains PAID and reconciles '+condition,async()=>{
      const {service,id,checkout}=await begin();
      try{
        if(condition==='PAUSED'||condition==='CLOSED')await pool.query("UPDATE public.queue_sessions SET status=$2::public.queue_session_status,closed_at=CASE WHEN $2::public.queue_session_status='CLOSED' THEN clock_timestamp() ELSE NULL END WHERE service_id=$1",[service,condition]);
        if(condition==='SERVICE_INACTIVE')await pool.query('UPDATE public.services SET is_active=false WHERE id=$1',[service]);
        if(condition==='BRANCH_INACTIVE')await pool.query('UPDATE public.branches SET is_active=false WHERE id=$1',[branch]);
        if(condition==='BUSINESS_INACTIVE')await pool.query('UPDATE public.businesses SET is_active=false WHERE id=$1',[biz]);
        if(condition==='EXPIRED')await pool.query("UPDATE public.join_requests SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[id]);
        const paid=await confirm(checkout.payment.id);assert.equal(paid.payment.status,'PAID');assert.equal(paid.joinRequest.status,'RECONCILIATION_REQUIRED');assert.equal(paid.ticketId,null);assert.equal(paid.canRetry,false);assert.equal(await ticketCount(id),0);
        assert.equal((await pool.query('SELECT last_number FROM public.queue_sessions WHERE service_id=$1',[service])).rows[0].last_number,0);
      }finally{
        await pool.query('UPDATE public.businesses SET is_active=true WHERE id=$1',[biz]);await pool.query('UPDATE public.branches SET is_active=true WHERE id=$1',[branch]);
        await pool.query('UPDATE public.services SET is_active=true WHERE id=$1',[service]);await pool.query("UPDATE public.queue_sessions SET status='OPEN',closed_at=NULL WHERE service_id=$1",[service]);
      }
      assert.equal((await confirm(checkout.payment.id)).joinRequest.status,'RECONCILIATION_REQUIRED');assert.equal(await ticketCount(id),0);
      await api('/join-requests/'+id+'/payments',{},409);
    });
    await t.test('natural timeout is lazy and retry is blocked once the request expires',async()=>{
      const {id,checkout}=await begin();
      await pool.query("UPDATE public.payments SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[checkout.payment.id]);
      assert.equal((await api('/join-requests/'+id)).payment.status,'EXPIRED');
      const next=await retry(id);assert.equal(next.payment.status,'PENDING');
      await pool.query("UPDATE public.join_requests SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[id]);
      const expired=await api('/join-requests/'+id);assert.equal(expired.joinRequest.status,'EXPIRED');assert.equal(expired.canRetry,false);
      await api('/join-requests/'+id+'/payments',{},409);assert.equal(await ticketCount(id),0);
    });
  }finally{
    auth.mock.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await run(async client=>{
      for(const table of ['queue_command_keys','queue_events','queue_tickets','payment_events','payments','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])await client.query('DELETE FROM public.'+table+' WHERE business_id=$1',[biz]);
      await client.query('DELETE FROM public.businesses WHERE id=$1',[biz]);await client.query('DELETE FROM public.profiles WHERE user_id=ANY($1::uuid[])',[users]);await client.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[users]);
    });await pool.end();
  }
});
