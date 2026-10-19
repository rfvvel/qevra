import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import type {CustomerTicketSnapshot,CustomerJoinResult,QueueCommandResult,CheckoutDto,MockWhatsAppNotification,PaymentMode} from '@qevra/contracts';
test('Phase 6 notifications, consent, ownership and failure isolation',{skip:!process.env.TEST_DATABASE_URL},async t=>{
  process.env.NODE_ENV='test';process.env.PAYMENT_PROVIDER='MOCK';process.env.MOCK_WHATSAPP_ENABLED='true';
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='test-public-key';
  const {createApp}=await import('../apps/api/src/app.js'),{getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
  const {mockWhatsAppProvider}=await import('../apps/api/src/modules/notifications/provider.js');
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8,connectionTimeoutMillis:15000});
  const owner=randomUUID(),users=Array.from({length:5},()=>randomUUID()),[a,b,c,,e]=users as [string,string,string,string,string];
  const biz=randomUUID(),branch=randomUUID(),otherBiz=randomUUID(),otherBranch=randomUUID(),slug='notify-'+branch;
  const auth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>[owner,...users].includes(token)?{data:{user:{id:token,is_anonymous:token!==owner}},error:null}:{data:{user:null},error:new Error('Invalid')});
  async function run<T>(operation:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
    const client=await pool.connect();try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const server=createApp({runTransaction:run}).listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1';
  async function api<T=QueueCommandResult>(user:string,path:string,body?:unknown,status=200,key=randomUUID()):Promise<T>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+user,'Content-Type':'application/json','Idempotency-Key':key},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal(response.status,status,path);return await response.json() as T;
  }
  let index=0;
  async function createService(mode:PaymentMode='NONE',business=biz,branchId=branch){
    const service=randomUUID();
    await pool.query(`INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode,deposit_amount)
      VALUES($1,$2,$3,'Notification test',500000,15,$4,$5,$6)`,[service,business,branchId,'N'+String.fromCharCode(65+index++),mode,mode==='DEPOSIT'?50000:null]);
    await pool.query("INSERT INTO public.queue_sessions(business_id,branch_id,service_id,business_date) VALUES($1,$2,$3,(clock_timestamp() AT TIME ZONE 'Asia/Jakarta')::date)",[business,branchId,service]);
    return service;
  }
  const join=(user:string,service:string,extra:Record<string,unknown>={},key=randomUUID())=>api<CustomerJoinResult>(user,'/customer/join-requests',{branchSlug:slug,serviceId:service,customerName:'Notification customer',...extra},200,key);
  const snapshot=(user:string,id:string)=>api<CustomerTicketSnapshot>(user,'/customer/tickets/'+id);
  const mockView=(user:string,id:string,status=200)=>api<MockWhatsAppNotification[]>(user,'/customer/tickets/'+id+'/mock-whatsapp',undefined,status);
  const read=(user:string,id:string,status=200)=>api<{readAt:string}>(user,'/customer/notifications/'+id+'/read',{},status);
  const rows=async(id:string,type?:string)=>(await pool.query('SELECT * FROM public.notifications WHERE queue_ticket_id=$1'+(type?' AND type=$2':''),type?[id,type]:[id])).rows;
  const ticketIds:string[]=[];let service='',counter='',staff='';
  async function action(id:string,name:string){
    const version=(await pool.query('SELECT version FROM public.queue_tickets WHERE id=$1',[id])).rows[0].version;
    return api(owner,staff+'/tickets/'+id+'/'+name,{expectedVersion:version});
  }
  try{
    await run(async client=>{
      for(const user of [owner,...users])await client.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,$2)',[user,user!==owner]);
      await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Notification owner')",[owner]);
      for(const [business,branchId] of [[biz,branch],[otherBiz,otherBranch]]){
        await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Notification test',$2,$3)",[business,'notify-'+business,owner]);
        await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[business,owner]);
        await client.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,'Notification branch',$3,'Asia/Jakarta')",[branchId,business,'notify-'+branchId]);
      }
    });
    service=await createService();counter=randomUUID();staff='/businesses/'+biz+'/branches/'+branch+'/services/'+service;
    await pool.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,'Counter')",[counter,biz,branch,service]);
    await t.test('five NONE joins create one joined update each; E has four ahead and no near-turn yet',async()=>{
      for(const user of users){
        const key=randomUUID(),extra=user===c?{}:{phone:'081234567890',whatsappOptIn:user!==b};
        const result=await join(user,service,extra,key);assert.ok(result.ticketId);ticketIds.push(result.ticketId);
        if(user===a)assert.equal((await join(user,service,extra,key)).ticketId,result.ticketId);
        const updates=(await snapshot(user,result.ticketId)).notifications;assert.equal(updates.filter(n=>n.type==='QUEUE_JOINED').length,1);
      }
      const last=await snapshot(e,ticketIds[4]!);assert.equal(last.queue.peopleAhead,4);assert.equal(last.notifications.filter(n=>n.type==='NEAR_TURN').length,0);
    });
    await t.test('explicit consent and normalization gate mock messages; no opt-in defaults',async()=>{
      assert.ok((await mockView(a,ticketIds[0]!)).length>0);
      assert.equal((await mockView(b,ticketIds[1]!)).length,0);assert.equal((await mockView(c,ticketIds[2]!)).length,0);
      const stored=(await pool.query('SELECT phone_e164,whatsapp_opt_in_at FROM public.join_requests WHERE customer_auth_id=$1 AND service_id=$2',[a,service])).rows[0];
      assert.equal(stored.phone_e164,'+6281234567890');assert.ok(stored.whatsapp_opt_in_at);
      const messages=await mockView(e,ticketIds[4]!);assert.equal(messages[0]!.recipientMasked,'+62*******7890');assert.ok(!JSON.stringify(messages).includes('6281234567890'));
      await api(a,'/customer/join-requests',{branchSlug:slug,serviceId:service,customerName:'Invalid',whatsappOptIn:true},400);
    });
    await t.test('ownership, staff denial, read idempotency and public phone privacy',async()=>{
      const notification=(await snapshot(e,ticketIds[4]!)).notifications[0]!;
      await read(a,notification.id,404);await read(owner,notification.id,403);await mockView(a,ticketIds[4]!,404);await mockView(owner,ticketIds[4]!,403);
      const [first,repeat]=await Promise.all([read(e,notification.id),read(e,notification.id)]);assert.equal(first.readAt,repeat.readAt);
      assert.ok((await snapshot(e,ticketIds[4]!)).notifications.find(n=>n.id===notification.id)?.readAt);
      const catalog=await api(owner,'/public/branches/'+slug);assert.ok(!JSON.stringify(catalog).includes('phone'));assert.ok(!JSON.stringify(catalog).includes('6281234567890'));
    });
    await t.test('provider failure preserves CALLED; moving A out of WAITING generates near-turn once for E',async()=>{
      const failure=mock.method(mockWhatsAppProvider,'send',async()=>{throw new Error('Simulated failure');});
      const key=randomUUID();
      try{
        const result=await api(owner,staff+'/queue/call-next',{counterId:counter},200,key);assert.equal(result.ticketId,ticketIds[0]);
        assert.equal((await snapshot(a,ticketIds[0]!)).ticket.status,'CALLED');
      }finally{failure.mock.restore();}
      await api(owner,staff+'/queue/call-next',{counterId:counter},200,key);
      const called=await rows(ticketIds[0]!,'YOUR_TURN');assert.equal(called.find(n=>n.channel==='MOCK_WHATSAPP')?.status,'FAILED');assert.equal(called.find(n=>n.channel==='IN_APP')?.status,'SENT');
      const next=await snapshot(e,ticketIds[4]!);assert.equal(next.queue.peopleAhead,3);assert.equal(next.notifications.filter(n=>n.type==='NEAR_TURN').length,1);
      assert.equal(next.notifications.find(n=>n.type==='NEAR_TURN')?.message,'Only 3 customers are ahead of you.');
      await action(ticketIds[0]!,'start');await action(ticketIds[0]!,'complete');
      for(let i=0;i<3;i++)await snapshot(e,ticketIds[4]!);
      assert.equal((await rows(ticketIds[4]!,'NEAR_TURN')).filter(n=>n.channel==='IN_APP').length,1);
    });
    await t.test('E receives turn, start and completion; recall creates one update per new transition',async()=>{
      for(const id of ticketIds.slice(1,4)){assert.equal((await api(owner,staff+'/queue/call-next',{counterId:counter})).ticketId,id);await action(id,'start');await action(id,'complete');}
      const id=ticketIds[4]!;
      await api(owner,staff+'/queue/call-next',{counterId:counter});await action(id,'skip');
      assert.equal((await snapshot(e,id)).notifications.filter(n=>n.type==='QUEUE_SKIPPED').length,1);
      await action(id,'requeue');await api(owner,staff+'/queue/call-next',{counterId:counter});
      await action(id,'start');await action(id,'complete');
      const updates=(await snapshot(e,id)).notifications;
      assert.equal(updates.filter(n=>n.type==='YOUR_TURN').length,2);
      for(const type of ['QUEUE_JOINED','NEAR_TURN','SERVICE_STARTED','SERVICE_COMPLETED'])assert.equal(updates.filter(n=>n.type===type).length,1);
      const mock=await mockView(e,id);assert.ok(mock.some(n=>n.type==='SERVICE_COMPLETED'&&n.status==='SENT'));
    });
    await t.test('no-show and cancellation updates',async()=>{
      const noShow=(await join(a,service)).ticketId!,cancelled=(await join(b,service)).ticketId!;
      await api(owner,staff+'/queue/call-next',{counterId:counter});await action(noShow,'no-show');
      await api(b,'/customer/tickets/'+cancelled+'/cancel',{expectedVersion:1});
      assert.ok((await snapshot(a,noShow)).notifications.some(n=>n.type==='QUEUE_NO_SHOW'));
      assert.ok((await snapshot(b,cancelled)).notifications.some(n=>n.type==='QUEUE_CANCELLED'));
    });
    for(const mode of ['DEPOSIT','FULL'] as const)await t.test(mode+' preserves consent but sends nothing until paid admission',async()=>{
      const paidService=await createService(mode),joined=await join(e,paidService,{phone:'6281234567890',whatsappOptIn:true});
      assert.ok(joined.outcome==='PAYMENT_REQUIRED');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notifications n JOIN public.queue_tickets t ON t.id=n.queue_ticket_id WHERE t.service_id=$1',[paidService])).rows[0].n,0);
      const checkout=await api<CheckoutDto>(e,'/customer/join-requests/'+joined.joinRequestId);
      const paid=await api<CheckoutDto>(e,'/customer/payments/'+checkout.payment.id+'/mock',{outcome:'SUCCESS'});assert.ok(paid.ticketId);
      assert.equal((await snapshot(e,paid.ticketId)).notifications.filter(n=>n.type==='QUEUE_JOINED').length,1);
      assert.ok((await mockView(e,paid.ticketId)).some(n=>n.type==='QUEUE_JOINED'));
    });
    await t.test('reconciliation creates no queue-joined notification',async()=>{
      const paidService=await createService('FULL'),joined=await join(e,paidService,{phone:'+6281234567890',whatsappOptIn:true});assert.ok(joined.outcome==='PAYMENT_REQUIRED');
      const checkout=await api<CheckoutDto>(e,'/customer/join-requests/'+joined.joinRequestId);
      await pool.query("UPDATE public.queue_sessions SET status='PAUSED' WHERE service_id=$1",[paidService]);
      const paid=await api<CheckoutDto>(e,'/customer/payments/'+checkout.payment.id+'/mock',{outcome:'SUCCESS'});
      assert.equal(paid.joinRequest.status,'RECONCILIATION_REQUIRED');assert.equal(paid.ticketId,null);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notifications n JOIN public.queue_tickets t ON t.id=n.queue_ticket_id WHERE t.service_id=$1',[paidService])).rows[0].n,0);
    });
    await t.test('notification persistence failure rolls back only notification work',async()=>{
      const isolated=await createService();
      const invalid=mock.method(mockWhatsAppProvider,'send',async()=>({status:'SENT' as const,recipientMasked:'invalid'}));
      try{
        const joined=await join(e,isolated,{phone:'081234567890',whatsappOptIn:true});assert.ok(joined.ticketId);
        assert.equal((await snapshot(e,joined.ticketId)).ticket.status,'WAITING');
        assert.equal((await rows(joined.ticketId)).length,0);
        const failures=await pool.query("SELECT 1 FROM public.notification_events n JOIN public.queue_events q ON q.id=n.queue_event_id WHERE q.queue_ticket_id=$1 AND n.kind='GENERATION_FAILED'",[joined.ticketId]);
        assert.equal(failures.rowCount,1);
      }finally{invalid.mock.restore();}
    });
    await t.test('cross-business access and forged owner persistence are denied',async()=>{
      const foreignService=await createService('NONE',otherBiz,otherBranch);
      const joined=await api<CustomerJoinResult>(b,'/customer/join-requests',{branchSlug:'notify-'+otherBranch,serviceId:foreignService,customerName:'Other tenant'});assert.ok(joined.ticketId);
      const other=(await snapshot(b,joined.ticketId)).notifications[0]!;
      await api(a,'/customer/tickets/'+joined.ticketId,undefined,404);await read(a,other.id,404);await mockView(a,joined.ticketId,404);
      await assert.rejects(pool.query("UPDATE public.notifications SET customer_user_id=$2 WHERE id=$1",[other.id,a]),{code:'23503'});
      await assert.rejects(pool.query("UPDATE public.notifications SET business_id=$2 WHERE id=$1",[other.id,biz]),{code:'23503'});
    });
  }finally{
    auth.mock.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await run(async client=>{
      for(const table of ['queue_command_keys','queue_events','queue_tickets','payment_events','payments','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])await client.query('DELETE FROM public.'+table+' WHERE business_id=ANY($1::uuid[])',[[biz,otherBiz]]);
      await client.query('DELETE FROM public.businesses WHERE id=ANY($1::uuid[])',[[biz,otherBiz]]);await client.query('DELETE FROM public.profiles WHERE user_id=$1',[owner]);await client.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,...users]]);
    });await pool.end();
  }
});
