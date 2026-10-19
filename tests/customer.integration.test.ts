import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import type {CustomerTicketSnapshot,QueueSnapshot,QueueCommandResult,PublicBranchDto} from '@qevra/contracts';
test('Phase 4 customer admission, privacy, ETA and cancellation on PostgreSQL',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='test-public-key';
  const {createApp}=await import('../apps/api/src/app.js');
  const {getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,connectionTimeoutMillis:15000});
  const owner=randomUUID(),a=randomUUID(),b=randomUUID(),c=randomUUID(),d=randomUUID();
  const users=[owner,a,b,c,d],biz=randomUUID(),branch=randomUUID(),slug='customer-test-'+branch;
  const ids={none:randomUUID(),paid:randomUUID(),full:randomUUID(),notOpened:randomUUID(),paused:randomUUID(),closed:randomUUID(),inactive:randomUUID()};
  const counters=[randomUUID(),randomUUID()];
  const otherBusiness=randomUUID(),otherBranch=randomUUID(),otherService=randomUUID();
  const callerAuth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>users.includes(token)?{data:{user:{id:token,is_anonymous:token!==owner}},error:null}:{data:{user:null},error:new Error('Invalid')});
  async function run<T>(operation:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
    const client=await pool.connect();try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const server=createApp({runTransaction:run,disableMockPayments:true}).listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1';
  async function request<T=QueueCommandResult>(user:string|null,path:string,body?:unknown,status=200,key=randomUUID()):Promise<T>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(user?{Authorization:'Bearer '+user}:{}),'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status,path+' status');return await response.json() as T;
  }
  const staff='/businesses/'+biz+'/branches/'+branch+'/services/'+ids.none;
  const customerBody=(serviceId=ids.none)=>({branchSlug:slug,serviceId,customerName:'Private customer',phone:'0812 3456 7890'});
  const get=(user:string,id:string,status=200)=>request<CustomerTicketSnapshot>(user,'/customer/tickets/'+id,undefined,status);
  let ticketA='',ticketB='',ticketC='';
  try{
    await run(async client=>{
      for(const user of users)await client.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,$2)',[user,user!==owner]);
      await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Customer test owner')",[owner]);
      await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Customer test business',$2,$3)",[biz,'cust-'+biz,owner]);
      await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[biz,owner]);
      await client.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,'Customer branch',$3,'Asia/Jakarta')",[branch,biz,slug]);
      let index=0;
      for(const [name,id] of Object.entries(ids)){
        await client.query(`INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode,deposit_amount,is_active)
          VALUES($1,$2,$3,$4,100000,30,$5,$6,$7,$8)`,[id,biz,branch,name,String.fromCharCode(72+index++),name==='paid'?'DEPOSIT':name==='full'?'FULL':'NONE',name==='paid'?20000:null,name!=='inactive']);
        if(name!=='notOpened')await client.query(`INSERT INTO public.queue_sessions(business_id,branch_id,service_id,business_date,status,closed_at)
          VALUES($1,$2,$3,(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date,$4::public.queue_session_status,CASE WHEN $4::public.queue_session_status='CLOSED' THEN clock_timestamp() ELSE NULL END)`,[biz,branch,id,name==='paused'?'PAUSED':name==='closed'?'CLOSED':'OPEN']);
      }
      for(const counter of counters)await client.query('INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,$5)',[counter,biz,branch,ids.none,'Counter '+counter]);
    });
    await t.test('catalog exposes availability and paid mode, never customer data',async()=>{
      const publicData=await request<PublicBranchDto>(null,'/public/branches/'+slug);
      assert.ok(publicData.services.some(service=>service.payment_mode==='DEPOSIT'));
      assert.equal(publicData.services.find(service=>service.id===ids.notOpened)?.queue_status,'NOT_OPENED');
      assert.ok(!publicData.services.some(service=>service.id===ids.inactive));
      assert.ok(!JSON.stringify(publicData).includes('phone'));
    });
    await t.test('only anonymous customers can join and input cannot override configuration',async()=>{
      await request(null,'/customer/join-requests',customerBody(),401);
      await request(owner,'/customer/join-requests',customerBody(),403);
      await request(a,'/customer/join-requests',{...customerBody(),price:0},400);
      await request(a,'/customer/join-requests',{...customerBody(),customer_auth_id:b},400);
      await request(a,staff+'/queue',undefined,403);
    });
    await t.test('paid, not-opened, paused, closed, inactive admission fails without requests or tickets',async()=>{
      for(const id of [ids.paid,ids.full,ids.notOpened,ids.paused,ids.closed,ids.inactive])await request(a,'/customer/join-requests',customerBody(id),409);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.join_requests WHERE business_id=$1',[biz])).rows[0].n,0);
      await pool.query('UPDATE public.branches SET is_active=false WHERE id=$1',[branch]);
      try{await request(a,'/customer/join-requests',customerBody(),409);}finally{await pool.query('UPDATE public.branches SET is_active=true WHERE id=$1',[branch]);}
      await pool.query('UPDATE public.businesses SET is_active=false WHERE id=$1',[biz]);
      try{await request(a,'/customer/join-requests',customerBody(),409);}finally{await pool.query('UPDATE public.businesses SET is_active=true WHERE id=$1',[biz]);}
    });
    await t.test('concurrent duplicate customer join returns one admitted ticket and retries recover it',async()=>{
      const key=randomUUID(),body=customerBody();
      const results=await Promise.all([request(a,'/customer/join-requests',body,200,key),request(a,'/customer/join-requests',body,200,key)]);
      assert.equal(results[0].ticketId,results[1].ticketId);ticketA=results[0].ticketId!;
      assert.deepEqual(await request(a,'/customer/join-requests',body,200,key),results[0]);
      assert.equal((await request(a,'/customer/join-requests',body)).ticketId,ticketA);
      const stored=(await pool.query('SELECT status,phone_e164 FROM public.join_requests WHERE business_id=$1',[biz])).rows;
      assert.equal(stored.length,1);assert.equal(stored[0].status,'ADMITTED');assert.equal(stored[0].phone_e164,'+6281234567890');
      const snapshot=await get(a,ticketA);assert.equal(snapshot.ticket.queueNumber,'H001');
      await request(a,'/customer/join-requests',{...body,customerName:'Changed'},409,key);
    });
    await t.test('peopleAhead and ETA use two counters without exposing other customers',async()=>{
      ticketB=(await request(b,'/customer/join-requests',{...customerBody(),customerName:'Secret B'})).ticketId!;
      ticketC=(await request(c,'/customer/join-requests',{branchSlug:slug,serviceId:ids.none,customerName:'Secret C'})).ticketId!;
      const snapshot=await get(c,ticketC);
      assert.equal(snapshot.ticket.queueNumber,'H003');assert.equal(snapshot.queue.peopleAhead,2);
      assert.equal(snapshot.queue.etaStatus,'AVAILABLE');assert.equal(snapshot.queue.estimatedWaitMinutes,30);
      const body=JSON.stringify(snapshot);for(const secret of ['Secret B','Secret C','Private customer','6281234567890','customer_auth_id',owner,biz])assert.ok(!body.includes(secret));
      const active=await request<{ticketId:string}>(a,'/customer/active-ticket?serviceId='+ids.none);assert.equal(active.ticketId,ticketA);
      assert.equal(await request(d,'/customer/active-ticket?serviceId='+ids.none),null);
    });
    await t.test('UUIDs and visible numbers do not authorize another customer; realtime topics are owner-scoped',async()=>{
      await get(b,ticketA,404);await get(d,ticketB,404);
      await request(b,'/customer/tickets/'+ticketA+'/cancel',{expectedVersion:1},404);
      await request(a,'/customer/tickets/H001',undefined,400);
      const topic=(await get(a,ticketA)).queue.realtimeTopic;
      await run(async client=>{
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a,is_anonymous:true,role:'authenticated'})]);
        await client.query('SET LOCAL ROLE authenticated');
        assert.equal((await client.query('SELECT public.customer_owns_queue_topic($1) AS allowed',[topic])).rows[0].allowed,true);
        assert.equal((await client.query('SELECT public.customer_owns_queue_topic($1) AS allowed',['queue:'+randomUUID()])).rows[0].allowed,false);
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:d,is_anonymous:true,role:'authenticated'})]);
        assert.equal((await client.query('SELECT public.customer_owns_queue_topic($1) AS allowed',[topic])).rows[0].allowed,false);
      });
    });
    await t.test('no active counters gives no numeric ETA and configuration increments revision',async()=>{
      const before=await get(c,ticketC);
      await pool.query('UPDATE public.service_counters SET is_active=false WHERE service_id=$1',[ids.none]);
      const after=await get(c,ticketC);assert.equal(after.queue.etaStatus,'PAUSED');assert.equal(after.queue.estimatedWaitMinutes,null);assert.ok(BigInt(after.queue.revision)>BigInt(before.queue.revision));
      await pool.query('UPDATE public.service_counters SET is_active=true WHERE service_id=$1',[ids.none]);
    });
    await t.test('staff call updates peopleAhead/handling; CALLED cannot be customer-cancelled',async()=>{
      const called=await request(owner,staff+'/queue/call-next',{counterId:counters[0]});assert.equal(called.ticketId,ticketA);
      const before=await get(a,ticketA);assert.equal(before.ticket.status,'CALLED');
      await request(a,'/customer/tickets/'+ticketA+'/cancel',{expectedVersion:before.ticket.version},409);
      const next=await get(c,ticketC);assert.equal(next.queue.peopleAhead,1);assert.deepEqual(next.queue.nowServing,['H001']);
      await request(owner,staff+'/tickets/'+ticketA+'/start',{expectedVersion:before.ticket.version});
      const serving=await get(a,ticketA);assert.equal(serving.ticket.status,'SERVING');
      await request(owner,staff+'/tickets/'+ticketA+'/complete',{expectedVersion:serving.ticket.version});
      assert.equal((await get(a,ticketA)).ticket.status,'COMPLETED');
    });
    await t.test('own waiting cancellation is atomic, idempotent and releases position',async()=>{
      const before=await get(b,ticketB),key=randomUUID(),body={expectedVersion:before.ticket.version};
      const cancelled=await request(b,'/customer/tickets/'+ticketB+'/cancel',body,200,key);
      assert.deepEqual(await request(b,'/customer/tickets/'+ticketB+'/cancel',body,200,key),cancelled);
      assert.equal((await get(b,ticketB)).ticket.status,'CANCELLED');
      assert.equal((await get(c,ticketC)).queue.peopleAhead,0);
      const audit=(await pool.query("SELECT actor_type,to_status,metadata FROM public.queue_events WHERE queue_ticket_id=$1 AND to_status='CANCELLED'",[ticketB])).rows;
      assert.equal(audit.length,1);assert.equal(audit[0].actor_type,'CUSTOMER');assert.deepEqual(audit[0].metadata,{});
      await request(b,'/customer/tickets/'+ticketB+'/cancel',body,409);
      const staffView=await request<QueueSnapshot>(owner,staff+'/queue');assert.equal(staffView.waiting.length,1);
    });
    await t.test('ticket ownership and join scope cannot cross business boundaries',async()=>{
      const otherSlug='other-customer-'+otherBranch;
      await run(async client=>{
        await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Other customer business',$2,$3)",[otherBusiness,'other-'+otherBusiness,owner]);
        await client.query("INSERT INTO public.branches(id,business_id,name,public_slug) VALUES($1,$2,'Other branch',$3)",[otherBranch,otherBusiness,otherSlug]);
        await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode) VALUES($1,$2,$3,'Other service',100,10,'X','NONE')",[otherService,otherBusiness,otherBranch]);
        await client.query("INSERT INTO public.queue_sessions(business_id,branch_id,service_id,business_date) VALUES($1,$2,$3,(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date)",[otherBusiness,otherBranch,otherService]);
      });
      const other=await request(d,'/customer/join-requests',{branchSlug:otherSlug,serviceId:otherService,customerName:'Other tenant customer'});
      await get(a,other.ticketId!,404);
      await request(a,'/customer/tickets/'+other.ticketId+'/cancel',{expectedVersion:1},404);
      await request(a,'/customer/join-requests',{branchSlug:slug,serviceId:otherService,customerName:'Wrong branch'},404);
      const own=await get(d,other.ticketId!);assert.equal(own.business.name,'Other customer business');
      assert.equal(await request(a,'/customer/active-ticket?serviceId='+otherService),null);
    });
  }finally{
    callerAuth.mock.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await run(async client=>{
      for(const table of ['queue_command_keys','queue_events','queue_tickets','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])
        await client.query('DELETE FROM public.'+table+' WHERE business_id=ANY($1::uuid[])',[[biz,otherBusiness]]);
      await client.query('DELETE FROM public.businesses WHERE id=ANY($1::uuid[])',[[biz,otherBusiness]]);
      await client.query('DELETE FROM public.profiles WHERE user_id=ANY($1::uuid[])',[users]);
      await client.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[users]);
    });await pool.end();
  }
});
