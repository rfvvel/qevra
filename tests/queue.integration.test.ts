import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import type {QueueSnapshot,QueueCommandResult} from '@qevra/contracts';
test('Phase 3 queue operations and independent-connection concurrency', {skip:!process.env.TEST_DATABASE_URL},async t=>{
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='test-public-key';
  const {createApp}=await import('../apps/api/src/app.js');
  const {getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
  const {admitJoinRequest}=await import('../apps/api/src/modules/queues/admission.js');
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,connectionTimeoutMillis:15000});
  const owner=randomUUID(),staff=randomUUID(),manager=randomUUID(),outsider=randomUUID(),guest=randomUUID();
  const users=[owner,staff,manager,outsider,guest];
  const biz=randomUUID(),branch=randomUUID(),otherBranch=randomUUID(),service=randomUUID(),otherService=randomUUID(),otherBranchService=randomUUID();
  const counters=[randomUUID(),randomUUID(),randomUUID()];
  const foreignCounter=randomUUID();
  const ids={businessId:biz,branchId:branch,serviceId:service};
  const actor={userId:owner,type:'STAFF' as const};
  const pids=new Set<number>();
  async function run<T>(operation:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
    const client=await pool.connect();
    try{await client.query('BEGIN');pids.add((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);const result=await operation(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const auth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>users.includes(token)?{data:{user:{id:token,is_anonymous:token===guest}},error:null}:{data:{user:null},error:new Error('Invalid')});
  const server=createApp({runTransaction:run}).listen(0,'127.0.0.1');await once(server,'listening');
  const root='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1/businesses/'+biz;
  const path='/branches/'+branch+'/services/'+service;
  async function call<T=QueueCommandResult>(suffix:string,body?:unknown,status=200,user=owner,key=randomUUID(),servicePath=path):Promise<T>{
    const response=await fetch(root+servicePath+suffix,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status,suffix+' expected '+status+' received '+response.status);
    return await response.json() as T;
  }
  async function snap(){return call<QueueSnapshot>('/queue');}
  async function request(sessionId:string,options:{customer?:string;targetService?:string;paid?:boolean;expired?:boolean}={}){
    const customer=options.customer??randomUUID(),id=randomUUID();
    await run(async c=>{
      if(!options.customer){users.push(customer);await c.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,true)',[customer]);}
      await c.query(`INSERT INTO public.join_requests(id,business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,status,payment_mode_snapshot,price_snapshot,amount_due,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'Demo queue customer',$7,$8,100,$9,clock_timestamp()-interval '2 hours',clock_timestamp()+$10::interval)`,
      [id,biz,branch,options.targetService??service,sessionId,customer,options.paid?'PAYMENT_PENDING':'READY',options.paid?'FULL':'NONE',options.paid?100:0,options.expired?'-1 hour':'1 hour']);
    });return {id,customer};
  }
  async function admit(id:string,target=ids){return run(c=>admitJoinRequest(c,target,actor,id));}
  async function ticketAction(ticketId:string,action:string,extra:Record<string,unknown>={},status=200){
    const row=(await pool.query('SELECT version FROM public.queue_tickets WHERE id=$1',[ticketId])).rows[0];
    return call('/tickets/'+ticketId+'/'+action,{expectedVersion:row.version,...extra},status);
  }
  let sessionId='';
  try{
    await run(async c=>{
      for(const user of users)await c.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,$2)',[user,user===guest]);
      await c.query("INSERT INTO public.profiles(user_id,display_name) SELECT unnest($1::uuid[]),'Queue fixture'",[users]);
      await c.query('INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,$2,$3,$4)',[biz,'Queue integration fixture','queue-test-'+biz,owner]);
      for(const [user,role] of [[owner,'OWNER'],[staff,'STAFF'],[manager,'MANAGER']]){
        const member=(await c.query('INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,$3) RETURNING id',[biz,user,role])).rows[0].id;
        if(user!==owner) {
          // Assign after branch/service creation below.
          await c.query('SELECT $1::uuid',[member]);
        }
      }
      for(const b of [branch,otherBranch])await c.query('INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,$3,$4,$5)',[b,biz,'Queue branch','q-'+b,'Pacific/Kiritimati']);
      for(const [s,b,prefix] of [[service,branch,'H'],[otherService,branch,'C'],[otherBranchService,otherBranch,'X']])
        await c.query("INSERT INTO public.services(id,business_id,branch_id,name,queue_prefix,price_amount,estimated_duration_minutes,payment_mode) VALUES($1,$2,$3,'Queue test',$4,100,15,'NONE')",[s,biz,b,prefix]);
      await c.query("INSERT INTO public.branch_members(business_id,branch_id,member_id) SELECT business_id,$2,id FROM public.business_members WHERE business_id=$1 AND role IN ('STAFF','MANAGER')",[biz,branch]);
      await c.query("INSERT INTO public.staff_services(business_id,branch_id,service_id,member_id) SELECT business_id,$2,$3,id FROM public.business_members WHERE business_id=$1 AND role='STAFF'",[biz,branch,service]);
      await c.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,'Other service counter')",[foreignCounter,biz,branch,otherService]);
      for(const counter of counters)await c.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,$5)",[counter,biz,branch,service,'Counter '+counter]);
    });
    await t.test('view creates no session; owner, manager, assigned STAFF permissions',async()=>{
      assert.equal((await snap()).session,null);
      await call('/queue',undefined,200,staff);await call('/queue',undefined,200,manager);
      await call('/queue',undefined,404,outsider);await call('/queue',undefined,403,guest);
      const other='/branches/'+branch+'/services/'+otherService;
      await call('/queue',undefined,404,staff,randomUUID(),other);await call('/queue',undefined,200,manager,randomUUID(),other);
      const remote='/branches/'+otherBranch+'/services/'+otherBranchService;
      await call('/queue',undefined,404,manager,randomUUID(),remote);await call('/queue',undefined,200,owner,randomUUID(),remote);
      const response=await fetch(root+path,{method:'PATCH',headers:{Authorization:'Bearer '+staff,'Content-Type':'application/json'},body:JSON.stringify({name:'Forbidden'})});assert.equal(response.status,403);
    });
    await t.test('concurrent open creates one daily session and respects branch date',async()=>{
      const results=await Promise.all([call('/queue/open',{},200,staff),call('/queue/open',{},200,manager)]);
      assert.equal(results[0].sessionId,results[1].sessionId);sessionId=results[0].sessionId;
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.queue_sessions WHERE service_id=$1',[service])).rows[0].n,1);
      assert.equal((await snap()).businessDate,(await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date::text AS day")).rows[0].day);
    });
    await t.test('concurrent admissions allocate unique sequential numbers and duplicate admission is idempotent',async()=>{
      const requests=await Promise.all(Array.from({length:6},()=>request(sessionId)));
      await Promise.all(requests.map(r=>admit(r.id)));
      const rows=(await pool.query('SELECT sequence_number,queue_order FROM public.queue_tickets WHERE service_id=$1 ORDER BY sequence_number',[service])).rows;
      assert.deepEqual(rows.map(r=>r.sequence_number),[1,2,3,4,5,6]);assert.equal(new Set(rows.map(r=>r.queue_order)).size,6);
      const duplicate=await Promise.all([admit(requests[0]!.id),admit(requests[0]!.id)]);assert.equal(duplicate[0].ticketId,duplicate[1].ticketId);
      assert.equal((await snap()).waiting[0]!.number,'H001');
      const repeated=await request(sessionId,{customer:requests[0]!.customer});await assert.rejects(admit(repeated.id),{status:409});
      const expired=await request(sessionId,{expired:true});await assert.rejects(admit(expired.id),{status:409});
      const paid=await request(sessionId,{paid:true});await assert.rejects(admit(paid.id),{status:409});
      assert.ok(pids.size>=2,'real distinct PostgreSQL connections used');
    });
    await t.test('simultaneous first admission of the same request creates one ticket and event',async()=>{
      const joined=await request(sessionId);
      const values=await Promise.all([admit(joined.id),admit(joined.id)]);
      assert.equal(values[0].ticketId,values[1].ticketId);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.queue_events WHERE queue_ticket_id=$1 AND event_type='TICKET_ADMITTED'",[values[0].ticketId])).rows[0].n,1);
    });
    await t.test('inactive service, expired request and wrong customer cannot consume a number',async()=>{
      const joined=await request(sessionId);
      const before=(await pool.query('SELECT last_number FROM public.queue_sessions WHERE id=$1',[sessionId])).rows[0].last_number;
      await pool.query('UPDATE public.services SET is_active=false WHERE id=$1',[service]);
      try{await assert.rejects(admit(joined.id),{status:409});}finally{await pool.query('UPDATE public.services SET is_active=true WHERE id=$1',[service]);}
      await assert.rejects(run(c=>admitJoinRequest(c,ids,{userId:guest,type:'CUSTOMER'},joined.id)),{status:404});
      assert.equal((await pool.query('SELECT last_number FROM public.queue_sessions WHERE id=$1',[sessionId])).rows[0].last_number,before);
    });
    await t.test('number allocation is independent per service',async()=>{
      const other='/branches/'+branch+'/services/'+otherService;
      const opened=await call('/queue/open',{},200,owner,randomUUID(),other);
      const req=await request(opened.sessionId,{targetService:otherService});
      await admit(req.id,{...ids,serviceId:otherService});
      const result=await call<QueueSnapshot>('/queue',undefined,200,owner,randomUUID(),other);
      assert.equal(result.waiting[0]!.number,'C001');
    });
    await t.test('pause blocks admissions and calls; stale revision conflicts; resume works',async()=>{
      let state=await snap();await call('/queue/pause',{sessionId,expectedRevision:state.revision});
      await call('/queue/call-next',{counterId:counters[0]},409);
      const req=await request(sessionId);await assert.rejects(admit(req.id),{status:409});
      await call('/queue/resume',{sessionId,expectedRevision:state.revision},409);
      state=await snap();await call('/queue/resume',{sessionId,expectedRevision:state.revision});
    });
    await t.test('concurrent call-next on distinct counters never selects same ticket',async()=>{
      const results=await Promise.all([call('/queue/call-next',{counterId:counters[0]}),call('/queue/call-next',{counterId:counters[1]},200,staff)]);
      assert.notEqual(results[0].ticketId,results[1].ticketId);
      await call('/queue/call-next',{counterId:counters[0]},409);
      await call('/queue/call-next',{counterId:randomUUID()},404);
      await call('/queue/call-next',{counterId:foreignCounter},404);
      for(const result of results)await ticketAction(result.ticketId!,'skip');
    });
    await t.test('same-counter race has one success; replay creates no extra event',async()=>{
      const responses=await Promise.all([owner,staff].map(user=>fetch(root+path+'/queue/call-next',{method:'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({counterId:counters[0]})})));
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
      const called=(await snap()).called[0]!;
      const key=randomUUID(),body={expectedVersion:called.version};
      const replay=await Promise.all([call('/tickets/'+called.id+'/skip',body,200,owner,key),call('/tickets/'+called.id+'/skip',body,200,owner,key)]);
      assert.deepEqual(replay[0],replay[1]);
      await call('/tickets/'+called.id+'/skip',{expectedVersion:999},409,owner,key);
      const count=(await pool.query("SELECT count(*)::int AS n FROM public.queue_events WHERE queue_ticket_id=$1 AND to_status='SKIPPED'",[called.id])).rows[0].n;assert.equal(count,1);
    });
    await t.test('requeue keeps number, moves to tail; manual bypass needs reason',async()=>{
      const before=(await snap()).skipped[0]!;
      await ticketAction(before.id,'requeue');
      const after=(await snap()).waiting.find(r=>r.id===before.id)!;assert.equal(after.number,before.number);assert.ok(BigInt(after.queueOrder)>BigInt(before.queueOrder));
      await ticketAction(after.id,'call',{counterId:counters[0]},409);
      await ticketAction(after.id,'call',{counterId:counters[0],reason:'Development priority test'});
      await ticketAction(after.id,'start');await ticketAction(after.id,'skip',{},409);
      const running=await snap();
      await call('/queue/pause',{sessionId,expectedRevision:running.revision});
      await ticketAction(after.id,'complete');
      const paused=await snap();await call('/queue/resume',{sessionId,expectedRevision:paused.revision});
      await ticketAction(after.id,'complete',{},409);
    });
    await t.test('no-show, cancel and completion during closed sessions; empty queue result',async()=>{
      let state=await snap();
      for(const ticket of state.skipped)await ticketAction(ticket.id,'requeue');
      const called=await call('/queue/call-next',{counterId:counters[0]});await ticketAction(called.ticketId!,'no-show');
      state=await snap();for(const ticket of state.waiting.slice(1))await ticketAction(ticket.id,'cancel');
      const last=await call('/queue/call-next',{counterId:counters[0]});
      assert.equal((await call('/queue/call-next',{counterId:counters[1]})).outcome,'EMPTY');
      state=await snap();await call('/queue/close',{sessionId,expectedRevision:state.revision});
      await call('/queue/call-next',{counterId:counters[1]},409);
      const req=await request(sessionId);await assert.rejects(admit(req.id),{status:409});
      await ticketAction(last.ticketId!,'start');await ticketAction(last.ticketId!,'complete');
      await call('/queue/open',{},409);
      const events=await call<{events:unknown[]}>('/history');assert.ok(events.events.length>0);
      const snapshot=await snap();assert.ok(!JSON.stringify(snapshot).includes('phone'));assert.equal(snapshot.session?.status,'CLOSED');
    });
  }finally{
    auth.mock.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await run(async c=>{
      for(const table of ['queue_command_keys','queue_events','queue_tickets','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])
        await c.query('DELETE FROM public.'+table+' WHERE business_id=$1',[biz]);
      await c.query('DELETE FROM public.businesses WHERE id=$1',[biz]);
      await c.query('DELETE FROM public.profiles WHERE user_id=ANY($1::uuid[])',[users]);
      await c.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[users]);
    });
    await pool.end();
  }
});
