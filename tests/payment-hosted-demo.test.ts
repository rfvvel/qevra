import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {PoolClient} from 'pg';
import {mockPaymentEnabled} from '../apps/api/src/config/payments.js';

test('production MOCK requires both explicit flags; development remains compatible',()=>{
  for(const provider of ['MOCK','DISABLED'])for(const flag of [undefined,'false','true','TRUE','1'])
    assert.equal(mockPaymentEnabled({NODE_ENV:'production',PAYMENT_PROVIDER:provider,PAYMENT_HOSTED_DEMO_ENABLED:flag}),provider==='MOCK'&&flag==='true');
  assert.equal(mockPaymentEnabled({NODE_ENV:'development',PAYMENT_PROVIDER:'MOCK'}),true);
});

test('hosted demo routes preserve public capabilities, authorization and per-customer throttling',async()=>{
  Object.assign(process.env,{NODE_ENV:'production',PAYMENT_PROVIDER:'MOCK',PAYMENT_HOSTED_DEMO_ENABLED:'true',WHATSAPP_PROVIDER:'DISABLED',
    SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'offline'});
  const {createApp}=await import('../apps/api/src/app.js');
  const {getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
  const user=randomUUID(),other=randomUUID(),payment=randomUUID();
  const auth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>({data:{user:{id:token==='other'?other:user,is_anonymous:token!=='staff'}},error:null}));
  let ownedChecks=0;
  const c={query:async(sql:string,params:unknown[])=>{
    if(sql.includes('SELECT br.id'))return {rows:[{id:randomUUID(),business_id:randomUUID(),business_name:'Any business',name:'Any branch',public_slug:params[0],timezone:'Asia/Jakarta'}]};
    if(sql.includes('SELECT s.id, s.name'))return {rows:['NONE','DEPOSIT','FULL'].map(payment_mode=>({id:randomUUID(),payment_mode,queue_status:'OPEN'}))};
    if(sql.includes('SELECT p.* FROM public.payments')){assert.match(sql,/customer_auth_id=\$2/);assert.ok(params[1]===user||params[1]===other);ownedChecks++;return {rows:[]};}
    throw new Error('Unexpected offline query');
  }} as unknown as PoolClient;
  const server=createApp({runTransaction:async op=>op(c)}).listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1';
  const post=(token?:string)=>fetch(base+'/customer/payments/'+payment+'/mock',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({outcome:'SUCCESS'})});
  try{
    for(const slug of ['first-business','another-branch']){
      const response=await fetch(base+'/public/branches/'+slug);assert.equal(response.status,200);
      const data=await response.json();assert.equal(data.services.length,3);
      for(const service of data.services){assert.equal(service.online_payment_available,true);assert.equal(service.payment_simulated,service.payment_mode!=='NONE');}
    }
    assert.equal((await post()).status,401);assert.equal((await post('staff')).status,403);assert.equal(ownedChecks,0);
    for(let i=0;i<30;i++)assert.equal((await post('customer')).status,404);
    const limited=await post('customer');assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));
    assert.equal((await post('other')).status,404);assert.equal(ownedChecks,31);
    assert.equal((await fetch(base+'/customer/tickets/'+randomUUID()+'/mock-whatsapp')).status,404);
  }finally{auth.mock.restore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('existing payment engine admits DEPOSIT/FULL once and NONE directly using isolated in-memory SQL fixtures',async()=>{
  const {join}=await import('../apps/api/src/modules/customer/service.js');
  const {paymentService}=await import('../apps/api/src/modules/payments/service.js');
  const {notificationService}=await import('../apps/api/src/modules/notifications/service.js');
  const notifications=mock.method(notificationService,'handleQueueEvent',async()=>{});
  try{for(const mode of ['DEPOSIT','FULL','NONE']){
    const user=randomUUID(),ids={businessId:randomUUID(),branchId:randomUUID(),serviceId:randomUUID()},sessionId=randomUUID();
    const context={...ids,businessDate:'2026-10-21',timezone:'Asia/Jakarta',serviceName:'Service',branchName:'Branch',prefix:'A',businessActive:true,branchActive:true,serviceActive:true,paymentMode:mode,price:'100000'};
    let request:Record<string,unknown>|undefined,payment:Record<string,unknown>|undefined,ticket:string|undefined,admissions=0;
    const events=new Map<string,string>();
    const client={query:async(sql:string,p:unknown[]=[])=>{
      const rows=(values:unknown[])=>({rows:values,rowCount:values.length});
      if(sql.includes('AS "businessId"')&&sql.includes('br.public_slug=$2'))return rows([ids]);
      if(sql.includes('SELECT id FROM public.businesses'))return rows([{id:ids.businessId}]);
      if(sql.includes('AS "serviceName"'))return rows([context]);
      if(sql.includes('pg_advisory_xact_lock')||sql.includes('public.queue_command_keys'))return rows([]);
      if(sql.startsWith('SELECT id,service_id,prefix_snapshot'))return rows([]);
      if(sql.includes("status IN ('PAYMENT_PENDING','RECONCILIATION_REQUIRED')"))return rows([]);
      if(sql.startsWith('SELECT id,status,business_date'))return rows([{id:sessionId,status:'OPEN',business_date:context.businessDate,revision:'1'}]);
      if(sql.startsWith('SELECT deposit_amount'))return rows([{deposit_amount:'25000'}]);
      if(sql.startsWith('INSERT INTO public.join_requests')){
        request={id:randomUUID(),business_id:ids.businessId,branch_id:ids.branchId,service_id:ids.serviceId,queue_session_id:sessionId,customer_auth_id:user,
          status:mode==='NONE'?'READY':'PAYMENT_PENDING',payment_mode_snapshot:mode,price_snapshot:'100000',amount_due:mode==='DEPOSIT'?'25000':mode==='FULL'?'100000':'0',currency:'IDR',unexpired:true,expires_at:new Date(Date.now()+1800000)};
        if(mode!=='NONE')assert.equal(p[9],request.amount_due);return rows([request]);
      }
      if(sql.startsWith('INSERT INTO public.payments')){assert.equal(p[3],'MOCK');payment={id:p[0],business_id:p[1],join_request_id:p[2],provider:p[3],provider_reference:p[4],amount:p[5],currency:p[6],expires_at:p[7],created_at:new Date(),paid_at:null,status:'PENDING',is_settlement:false};return rows([payment]);}
      if(sql.startsWith('INSERT INTO public.payment_events')){events.set(String(p[4]),String(p[6]));return rows([]);}
      if(sql.startsWith('SELECT payload_hash'))return rows(events.has(String(p[1]))?[{payload_hash:events.get(String(p[1]))}]:[]);
      if(sql.includes('SELECT p.* FROM public.payments'))return rows(p[1]===user&&payment?[payment]:[]);
      if(sql.startsWith('SELECT * FROM public.payments'))return rows(payment?[{...payment}]:[]);
      if(sql.startsWith('SELECT *,expires_at'))return rows(request&&(!sql.includes('customer_auth_id=$2')||p[1]===user)?[{...request}]:[]);
      if(sql.startsWith('SELECT queue_session_id FROM'))return rows([{queue_session_id:sessionId}]);
      if(sql.startsWith("UPDATE public.payments SET status='PAID'")){Object.assign(payment!,{status:'PAID',is_settlement:p[1],paid_at:new Date()});return rows([]);}
      if(sql.startsWith('UPDATE public.payments'))return rows([]);
      if(sql.startsWith('SELECT 1 FROM public.payments'))return rows(payment?.status==='PAID'&&payment.is_settlement?[{ok:1}]:[]);
      if(sql.includes("status IN ('WAITING','CALLED','SERVING')"))return rows(ticket?[{id:ticket}]:[]);
      if(sql.startsWith('UPDATE public.queue_sessions SET last_number'))return rows([{last_number:1,next_order:'1'}]);
      if(sql.startsWith('INSERT INTO public.queue_tickets')){admissions++;ticket=randomUUID();return rows([{id:ticket}]);}
      if(sql.startsWith("UPDATE public.join_requests SET status='ADMITTED'")){request!.status='ADMITTED';return rows([]);}
      if(sql.startsWith('SELECT id FROM public.queue_tickets WHERE join_request_id'))return rows(ticket?[{id:ticket}]:[]);
      if(sql.startsWith('SELECT name,public_slug'))return rows([{name:'Branch',public_slug:'demo'}]);
      if(sql.startsWith('INSERT INTO public.queue_events'))return rows([{id:randomUUID()}]);
      if(sql.startsWith('UPDATE public.queue_sessions SET revision'))return rows([{revision:'2'}]);
      if(/^(SAVEPOINT|RELEASE SAVEPOINT)/.test(sql))return rows([]);
      throw new Error('Unexpected fixture query: '+sql);
    }} as unknown as PoolClient;
    const joined=await join(client,user,randomUUID(),{branchSlug:'demo',serviceId:ids.serviceId,customerName:'Demo',whatsappOptIn:false},true);
    if(mode==='NONE'){assert.equal(joined.outcome,'APPLIED');assert.equal(payment,undefined);assert.equal(admissions,1);continue;}
    assert.equal(joined.outcome,'PAYMENT_REQUIRED');assert.equal(admissions,0);
    await assert.rejects(paymentService.mockConfirm(client,randomUUID(),String(payment!.id),randomUUID(),'SUCCESS',true));assert.equal(admissions,0);
    await assert.rejects(paymentService.mockConfirm(client,user,String(payment!.id),randomUUID(),'SUCCESS',false));assert.equal(admissions,0);
    const key=randomUUID();
    const first=await paymentService.mockConfirm(client,user,String(payment!.id),key,'SUCCESS',true);
    assert.equal(first.payment.provider,'MOCK');assert.equal(first.payment.status,'PAID');assert.equal(first.ticketId,ticket);assert.equal(admissions,1);
    assert.equal(first.pricing.payNow,mode==='DEPOSIT'?'25000':'100000');
    const duplicate=await paymentService.mockConfirm(client,user,String(payment!.id),key,'SUCCESS',true);
    assert.equal(duplicate.ticketId,first.ticketId);assert.equal(admissions,1);
    await assert.rejects(paymentService.mockConfirm(client,user,String(payment!.id),key,'FAILURE',true));assert.equal(admissions,1);
    const repeat=await paymentService.mockConfirm(client,user,String(payment!.id),randomUUID(),'SUCCESS',true);
    assert.equal(repeat.ticketId,first.ticketId);assert.equal(admissions,1);
  }}finally{notifications.mock.restore();}
});
