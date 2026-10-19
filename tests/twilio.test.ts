import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {PoolClient} from 'pg';
import express from 'express';
import {whatsappConfiguration} from '../apps/api/src/config/whatsapp.js';
import {TwilioWhatsAppProvider,windowOpen,verifyInbound,TWILIO_WEBHOOK_PATH} from '../apps/api/src/modules/notifications/twilio-provider.js';
import {createTwilioWebhook,validTwilioSignature} from '../apps/api/src/modules/notifications/twilio-webhook.js';
import {DeliveryError} from '../apps/api/src/modules/notifications/meta-provider.js';
import {WhatsAppOutbox,reconcile,type Job} from '../apps/api/src/modules/notifications/outbox.js';
import type {NotificationDelivery} from '../apps/api/src/modules/notifications/provider.js';

const config=whatsappConfiguration({WHATSAPP_PROVIDER:'TWILIO',NODE_ENV:'test',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),
 TWILIO_AUTH_TOKEN:'fixture-only',TWILIO_WHATSAPP_FROM:'whatsapp:+15005550006',TWILIO_WEBHOOK_ORIGIN:'https://demo.example.test'});
const sid='SM'+'2'.repeat(32),now=Date.now();
const delivery:NotificationDelivery={phone:'+6281234567890',consented:true,dedupeKey:randomUUID(),title:'unused',message:'unused',
 template:{type:'NEAR_TURN',branchName:'Demo',customerName:'Test',queueNumber:'Q001',peopleAhead:3}};
const sign=(path:string,body:Record<string,string>)=>createHmac('sha1',config.TWILIO_AUTH_TOKEN!).update(config.TWILIO_WEBHOOK_ORIGIN+path+Object.keys(body).sort().map(k=>k+body[k]).join('')).digest('base64');

test('Twilio requires explicit complete development configuration and canonical HTTPS origin',()=>{
 assert.equal(config.mode,'TWILIO');
 assert.throws(()=>whatsappConfiguration({WHATSAPP_PROVIDER:'TWILIO'}),/Missing WhatsApp/);
 assert.throws(()=>whatsappConfiguration({...config,NODE_ENV:'production'}),/development/);
 for(const origin of ['http://example.test','https://example.test/','https://example.test/path','https://user:password@example.test'])
  assert.throws(()=>whatsappConfiguration({...config,TWILIO_WEBHOOK_ORIGIN:origin}),/Invalid WhatsApp/);
});
test('consent, Indonesian mobile and verified recent inbound window are required before Twilio HTTP',async()=>{
 const never=async()=>{assert.fail('Unexpected real-send transport');};
 const provider=new TwilioWhatsAppProvider(config,async()=>new Date(now),never,()=>now);
 for(const patch of [{consented:false},{phone:null},{phone:'+12025550100'},{template:undefined}])assert.equal((await provider.send({...delivery,...patch})).status,'SKIPPED');
 for(const at of [null,new Date(now-24*3600000),new Date(now+1000),new Date('invalid')]){
  assert.equal(windowOpen(at,now),false);
  assert.equal((await new TwilioWhatsAppProvider(config,async()=>at,never,()=>now).send(delivery)).code,'TWILIO_WINDOW_CLOSED');
 }
 assert.equal(windowOpen(new Date(now-23*3600000),now),true);
 assert.equal(windowOpen(new Date(now-24*3600000+30000),now),false);
});
test('Twilio sends only the two queue bodies via form REST with signed-callback correlation',async()=>{
 const requests:URLSearchParams[]=[];
 const provider=new TwilioWhatsAppProvider(config,async()=>new Date(now),async(url,init)=>{
  assert.equal(url,'https://api.twilio.com/2010-04-01/Accounts/'+config.TWILIO_ACCOUNT_SID+'/Messages.json');
  assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.ok(init.signal);
  requests.push(new URLSearchParams(String(init.body)));return Response.json({sid,status:'queued'},{status:201});
 },()=>now);
 assert.equal((await provider.send(delivery)).providerMessageId,sid);
 await provider.send({...delivery,template:{...delivery.template!,type:'YOUR_TURN'}});
 assert.match(requests[0]!.get('Body')!,/3 pelanggan/);assert.match(requests[1]!.get('Body')!,/sedang dipanggil/);
 assert.equal(requests[0]!.get('To'),'whatsapp:'+delivery.phone);
 assert.equal(requests[0]!.get('StatusCallback'),config.TWILIO_WEBHOOK_ORIGIN+TWILIO_WEBHOOK_PATH+'/status?job='+delivery.dedupeKey);
 assert.equal(requests[0]!.get('ContentSid'),null);
});
test('Twilio retries explicit 20429 throttling only; uncertain outcomes are not automatically retried',async()=>{
 for(const [status,body,outcome] of [[429,{code:20429},'RETRY'],[400,{code:63016},'FAILED'],[400,{code:63015},'FAILED'],[500,{code:20500},'AMBIGUOUS'],[201,{},'AMBIGUOUS']] as const){
  await assert.rejects(new TwilioWhatsAppProvider(config,async()=>new Date(now),async()=>Response.json(body,{status}),()=>now).send(delivery),e=>e instanceof DeliveryError&&e.outcome===outcome);
 }
 await assert.rejects(new TwilioWhatsAppProvider(config,async()=>new Date(now),async()=>{throw new Error('private details');},()=>now).send(delivery),e=>e instanceof DeliveryError&&e.code==='TWILIO_TRANSPORT_UNCERTAIN'&&!e.message.includes('private'));
});
test('inbound verification uses original provider time and checks sender, account and direction',async()=>{
 const original=new Date(now-25*3600000).toUTCString();
 const resource={sid,account_sid:config.TWILIO_ACCOUNT_SID,direction:'inbound',from:'whatsapp:'+delivery.phone,to:config.TWILIO_WHATSAPP_FROM,date_created:original};
 const at=await verifyInbound(config,sid,delivery.phone!,async url=>{assert.match(url,/Messages\/SM[0-9]+\.json$/);return Response.json(resource);});
 assert.equal(at.toUTCString(),original);assert.equal(windowOpen(at,now),false);
 for(const patch of [{direction:'outbound-api'},{account_sid:'wrong'},{from:'whatsapp:+628999999999'},{date_created:'bad'}])
  await assert.rejects(verifyInbound(config,sid,delivery.phone!,async()=>Response.json({...resource,...patch})),/mismatch/);
});
test('Twilio webhook signatures bind public URL, every field and account; retries reuse original inbound date and receipt hash',async()=>{
 // Published Twilio signature example, independent of this test's signing helper.
 assert.equal(validTwilioSignature('https://example.com/myapp.php?foo=1&bar=2',
  {CallSid:'CA1234567890ABCDE',Caller:'+14158675310',Digits:'1234',From:'+14158675310',To:'+18005551212'},
  'L/OH5YylLD5NRKLltdqwSvS0BnU=','12345'),true);
 const writes:{sql:string;params:unknown[]}[]=[];let lookups=0;
 const client={query:async(sql:string,params:unknown[])=>{writes.push({sql,params});return {rows:[]};}} as unknown as PoolClient;
 const app=express();app.use(TWILIO_WEBHOOK_PATH,createTwilioWebhook(config,async op=>op(client),async()=>{lookups++;return new Date(now-25*3600000);}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 const path=TWILIO_WEBHOOK_PATH+'/inbound',body={AccountSid:config.TWILIO_ACCOUNT_SID!,From:'whatsapp:'+delivery.phone,To:config.TWILIO_WHATSAPP_FROM!,MessageSid:sid,Body:'not stored',ExtraFutureField:'included'};
 const post=(p:string,b:Record<string,string>,signature=sign(p,b))=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},body:new URLSearchParams(b)});
 try{
  assert.equal(validTwilioSignature(config.TWILIO_WEBHOOK_ORIGIN+path,{...body,Body:['x','y']},sign(path,body),config.TWILIO_AUTH_TOKEN!),false);
  assert.equal((await post(path,{...body,Body:'tampered'},sign(path,body))).status,403);assert.equal(lookups,0);assert.equal(writes.length,0);
  assert.equal((await post(path,{...body,AccountSid:'wrong'})).status,403);
  for(let i=0;i<2;i++)assert.equal((await post(path,body)).status,200);
  assert.equal(writes.length,2);assert.match(writes[0]!.sql,/ON CONFLICT DO NOTHING/);
  assert.deepEqual(writes[0]!.params,writes[1]!.params);assert.ok(!JSON.stringify(writes).includes('not stored'));
  writes.length=0;
  const statusPath=TWILIO_WEBHOOK_PATH+'/status?job='+delivery.dedupeKey;
  const statusBody={AccountSid:config.TWILIO_ACCOUNT_SID!,From:config.TWILIO_WHATSAPP_FROM!,To:'whatsapp:'+delivery.phone,MessageSid:sid,MessageStatus:'delivered'};
  for(let i=0;i<2;i++)assert.equal((await post(statusPath,statusBody)).status,204);
  const inserts=writes.filter(w=>w.sql.includes('INSERT'));assert.equal(inserts.length,2);assert.equal(inserts[0]!.params[0],inserts[1]!.params[0]);
  assert.equal(inserts[0]!.params[3],'delivered');
  assert.ok(writes.some(w=>w.params.includes('TWILIO_WHATSAPP')));
  for(const status of ['sent','read','failed','undelivered','canceled']){
   writes.length=0;assert.equal((await post(statusPath,{...statusBody,MessageStatus:status,ErrorCode:'63016'})).status,204);
   const row=writes.find(w=>w.sql.includes('INSERT'))!;
   assert.equal(row.params[3],['undelivered','canceled'].includes(status)?'failed':status);
   assert.equal(row.params[5],'TWILIO_63016');
  }
  writes.length=0;assert.equal((await post(statusPath,{...statusBody,MessageStatus:'queued'})).status,204);assert.equal(writes.length,0);
  const before=writes.length;assert.equal((await post(statusPath,statusBody,sign(TWILIO_WEBHOOK_PATH+'/status?job='+randomUUID(),statusBody))).status,403);assert.equal(writes.length,before);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('worker claims and lease recovery are provider-scoped and can be limited to fixture business',async()=>{
 const queries:{sql:string;params:unknown[]}[]=[],business=randomUUID();
 const c={query:async(sql:string,params:unknown[])=>{queries.push({sql,params});return {rows:[]};}} as unknown as PoolClient;
 const worker=new WhatsAppOutbox(async op=>op(c),{channel:'TWILIO_WHATSAPP',send:async()=>{assert.fail('No transport allowed');}},business);
 assert.equal(await worker.claim(),null);assert.equal(queries.length,2);
 for(const q of queries){assert.match(q.sql,/business_id=\$/);assert.match(q.sql,/channel::text=\$/);assert.ok(q.params.includes(business));assert.ok(q.params.includes('TWILIO_WHATSAPP'));}
});
test('a late failed receipt cannot regress an already-read delivery',async()=>{
 const job:Job={id:randomUUID(),business_id:randomUUID(),notification_id:randomUUID(),attempts:1,claim_token:randomUUID()};let updates=0;
 const c={query:async(sql:string)=>{
  if(sql.startsWith('SELECT * FROM public.whatsapp_outbox'))return {rows:[{provider_message_id:sid,delivery_status:'read'}]};
  if(sql.startsWith('SELECT * FROM public.whatsapp_receipts'))return {rows:[{provider_message_id:sid,status:'failed',error_code:'TWILIO_63016'}]};
  updates++;return {rows:[]};
 }} as unknown as PoolClient;
 assert.equal(await reconcile(c,job),true);assert.equal(updates,0);
});
