import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {analyticsQuerySchema,type AnalyticsDashboard} from '@qevra/contracts';
import {analyticsFixture} from './helpers/analytics-fixture.js';
test('analytics query validation',()=>{
 assert.equal(analyticsQuerySchema.parse({}).range,'TODAY');
 for(const input of [{range:'ALL'},{range:['TODAY']},{branchId:'no'},{unknown:'value'},{serviceId:''}])assert.equal(analyticsQuerySchema.safeParse(input).success,false);
});
test('Phase 7 operational analytics',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 process.env.NODE_ENV='test';process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='test-public-key';
 const {createApp}=await import('../apps/api/src/app.js'),{getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4,connectionTimeoutMillis:15000}),f=analyticsFixture();
 async function run<T>(op:(c:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const v=await op(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 const auth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>[f.owner,f.manager,f.staff,f.outsider,f.anonymous].includes(token)?{data:{user:{id:token,is_anonymous:token===f.anonymous}},error:null}:{data:{user:null},error:new Error('Invalid')});
 const server=createApp({runTransaction:run}).listen(0,'127.0.0.1');await once(server,'listening');
 async function api(user=f.owner,query='range=LAST_7_DAYS',status=200,business=f.business){
  const response=await fetch('http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1/businesses/'+business+'/analytics?'+query,{headers:{Authorization:'Bearer '+user}});
  assert.equal(response.status,status);return await response.json() as AnalyticsDashboard;
 }
 try{
  await run(f.seed);
  await t.test('cohort, outcomes, requeue, skip and valid duration samples',async()=>{
   const d=await api();assert.equal(d.summary.joined,11);assert.equal(d.summary.completed,5);assert.equal(d.summary.cancelled,1);assert.equal(d.summary.noShow,1);
   assert.equal(d.summary.waitSamples,8);assert.equal(d.summary.averageWaitMinutes,15.625);assert.equal(d.summary.serviceSamples,4);assert.equal(d.summary.averageServiceMinutes,30);
   assert.deepEqual(d.live,{waiting:1,called:0,serving:0});assert.deepEqual(d.busiestHour,{hour:9,joined:3});assert.equal(d.volume.length,24);assert.equal(d.volume.reduce((a,b)=>a+b.joined,0),11);
   assert.equal(d.byService.find(s=>s.id===f.services[0])?.joined,9);assert.equal(d.byBranch.find(b=>b.id===f.branches[0])?.joined,10);
  });
  await t.test('missing call event uses valid authoritative called_at timestamp',async()=>{
   await pool.query("DELETE FROM public.queue_events WHERE business_id=$1 AND event_type='TICKET_CALLED' AND queue_ticket_id IN (SELECT id FROM public.queue_tickets WHERE service_id=$2)",[f.business,f.services[1]]);
   const d=await api();assert.equal(d.summary.waitSamples,8);assert.equal(d.summary.averageWaitMinutes,15.625);
  });
  await t.test('today, 7-day and 30-day business dates; live never includes old waiting',async()=>{
   const today=await api(f.owner,'range=TODAY');assert.equal(today.summary.joined,1);assert.equal(today.summary.averageWaitMinutes,null);
   const month=await api(f.owner,'range=LAST_30_DAYS');assert.equal(month.summary.joined,12);assert.equal(month.summary.completed,6);assert.equal(month.summary.averageServiceMinutes,28);assert.deepEqual(month.live,today.live);
  });
  await t.test('branch/service filters and empty data',async()=>{
   assert.equal((await api(f.owner,'range=LAST_7_DAYS&branchId='+f.branches[1])).summary.joined,1);
   assert.equal((await api(f.owner,'range=LAST_7_DAYS&serviceId='+f.services[1])).summary.joined,1);
   const empty=await api(f.owner,'range=LAST_7_DAYS&serviceId='+f.services[3]);assert.equal(empty.summary.joined,0);assert.equal(empty.busiestHour,null);assert.equal(empty.summary.averageWaitMinutes,null);assert.equal(empty.volume.every(h=>h.joined===0),true);
  });
  await t.test('manager metadata and metrics are limited to assigned branches',async()=>{
   const d=await api(f.manager);assert.deepEqual(d.branches.map(b=>b.id),[f.branches[0]]);assert.equal(d.summary.joined,10);assert.equal(d.services.length,2);
   await api(f.manager,'branchId='+f.branches[1],404);await api(f.manager,'serviceId='+f.services[2],404);
  });
  await t.test('staff, anonymous, unauthenticated and cross-tenant access denied',async()=>{
   await api(f.staff,'',403);await api(f.anonymous,'',403);await api('invalid','',401);await api(f.outsider,'',404);await api(f.owner,'',404,f.otherBusiness);
  });
  await t.test('unknown, malformed and incompatible filters rejected',async()=>{
   for(const q of ['range=ALL','branchId=no','serviceId=no','extra=true','range=TODAY&range=LAST_7_DAYS'])await api(f.owner,q,400);
   await api(f.owner,'branchId='+f.branches[0]+'&serviceId='+f.services[2],404);
  });
  await t.test('requeued waiting excludes abandoned call; negative events excluded',async()=>{
   await run(async c=>{
    const row=(await c.query("SELECT id,queue_session_id,joined_at FROM public.queue_tickets WHERE business_id=$1 AND status='SKIPPED'",[f.business])).rows[0];
    await c.query("INSERT INTO public.queue_events(business_id,queue_session_id,queue_ticket_id,event_type,actor_type,occurred_at) VALUES($1,$2,$3,'TICKET_REQUEUED','SYSTEM',$4)",[f.business,row.queue_session_id,row.id,new Date(row.joined_at.getTime()+10*60000)]);
    await c.query("UPDATE public.queue_tickets SET status='WAITING',called_at=NULL WHERE id=$1",[row.id]);
    await c.query("INSERT INTO public.queue_events(business_id,queue_session_id,queue_ticket_id,event_type,actor_type,occurred_at) VALUES($1,$2,$3,'TICKET_CALLED','SYSTEM',$4)",[f.business,row.queue_session_id,row.id,new Date(row.joined_at.getTime()-60000)]);
   });
   const d=await api();assert.equal(d.summary.joined,11);assert.equal(d.summary.waitSamples,7);assert.ok(Math.abs(d.summary.averageWaitMinutes!-117/7)<1e-10);
  });
  await t.test('paused today stays live, closed or inactive context does not',async()=>{
   await pool.query("UPDATE public.queue_sessions SET status='PAUSED' WHERE business_id=$1",[f.business]);assert.equal((await api()).live.waiting,1);
   await pool.query("UPDATE public.queue_sessions SET status='CLOSED' WHERE business_id=$1",[f.business]);assert.equal((await api()).live.waiting,0);assert.equal((await api()).summary.joined,11);
  });
  await t.test('busiest-hour ties choose earliest hour and branch timezone defines buckets',async()=>{
   const coloring=await api(f.owner,'range=LAST_30_DAYS&serviceId='+f.services[1]);assert.deepEqual(coloring.busiestHour,{hour:9,joined:2});
   await pool.query("UPDATE public.branches SET timezone='UTC' WHERE id=$1",[f.branches[1]]);
   const utc=await api(f.owner,'range=LAST_7_DAYS&branchId='+f.branches[1]);assert.deepEqual(utc.busiestHour,{hour:7,joined:1});assert.equal(utc.branches.find(b=>b.id===f.branches[1])?.timezone,'UTC');
   await pool.query("UPDATE public.branches SET timezone='Asia/Jakarta' WHERE id=$1",[f.branches[1]]);
   await pool.query("UPDATE public.queue_tickets SET joined_at=joined_at+interval '5 hours' WHERE business_id=$1 AND service_id=$2 AND status='COMPLETED'",[f.business,f.services[1]]);
   const tie=await api();assert.deepEqual(tie.busiestHour,{hour:9,joined:2});
  });
  await t.test('unassigned managers receive no metadata; inactive entities retain history only',async()=>{
   await pool.query('DELETE FROM public.branch_members WHERE business_id=$1 AND member_id=(SELECT id FROM public.business_members WHERE business_id=$1 AND user_id=$2)',[f.business,f.manager]);
   const none=await api(f.manager);assert.equal(none.branches.length,0);assert.equal(none.services.length,0);assert.equal(none.summary.joined,0);
   await pool.query("UPDATE public.queue_sessions SET status='OPEN' WHERE business_id=$1",[f.business]);
   await pool.query('UPDATE public.branches SET is_active=false WHERE id=$1',[f.branches[0]]);
   const inactive=await api();assert.equal(inactive.live.waiting,0);assert.equal(inactive.summary.joined,11);
  });
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));auth.mock.restore();await run(f.cleanup);await pool.end();}
});
