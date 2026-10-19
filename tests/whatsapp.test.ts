import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import type {PoolClient} from 'pg';
import {whatsappConfiguration} from '../apps/api/src/config/whatsapp.js';
import {MetaWhatsAppProvider,DeliveryError} from '../apps/api/src/modules/notifications/meta-provider.js';
import {createWhatsAppWebhook,parseReceipts,verifySignature} from '../apps/api/src/modules/notifications/webhook.js';
import {retryDelaySeconds,WhatsAppOutbox,type Job} from '../apps/api/src/modules/notifications/outbox.js';
import type {NotificationDelivery} from '../apps/api/src/modules/notifications/provider.js';

// Entirely fabricated fixtures. No environment files, live tokens or Meta HTTP calls.
const config=whatsappConfiguration({WHATSAPP_PROVIDER:'META',META_WHATSAPP_ACCESS_TOKEN:'fixture-token',
 META_WHATSAPP_PHONE_NUMBER_ID:'123456',META_WHATSAPP_API_VERSION:'v25.0',META_WHATSAPP_APP_SECRET:'fixture-secret',
 META_WHATSAPP_WEBHOOK_VERIFY_TOKEN:'fixture-verify',META_WHATSAPP_NEAR_TURN_TEMPLATE:'qevra_near',
 META_WHATSAPP_YOUR_TURN_TEMPLATE:'qevra_called',META_WHATSAPP_TEMPLATE_LANGUAGE:'id'});
const delivery:NotificationDelivery={title:'Unused',message:'Never sent as free text',phone:'+6281234567890',consented:true,dedupeKey:randomUUID(),
 template:{type:'NEAR_TURN',branchName:'Branch',customerName:'Customer',queueNumber:'P001',peopleAhead:3}};

test('Meta selection fails closed; explicit mode overrides legacy mock; production mock stays disabled',()=>{
 assert.equal(whatsappConfiguration({}).mode,'DISABLED');
 assert.equal(whatsappConfiguration({MOCK_WHATSAPP_ENABLED:'true'}).mode,'MOCK');
 assert.equal(whatsappConfiguration({WHATSAPP_PROVIDER:'DISABLED',MOCK_WHATSAPP_ENABLED:'true'}).mode,'DISABLED');
 assert.equal(whatsappConfiguration({WHATSAPP_PROVIDER:'MOCK',NODE_ENV:'production'}).mode,'DISABLED');
 assert.throws(()=>whatsappConfiguration({WHATSAPP_PROVIDER:'META'}),/META_WHATSAPP_ACCESS_TOKEN/);
 assert.throws(()=>whatsappConfiguration({META_WHATSAPP_API_VERSION:'../../bad'}),/Invalid WhatsApp/);
});
test('Meta sends only configured templates with positional parameters, fixed host and opaque correlation',async()=>{
 const requests:{url:string;init:RequestInit}[]=[];
 const provider=new MetaWhatsAppProvider(config,async(url,init)=>{requests.push({url,init});return Response.json({messages:[{id:'wamid.fixture'}]});});
 assert.equal((await provider.send(delivery)).providerMessageId,'wamid.fixture');
 await provider.send({...delivery,template:{...delivery.template!,type:'YOUR_TURN'}});
 assert.equal(requests[0]!.url,'https://graph.facebook.com/v25.0/123456/messages');
 const near=JSON.parse(String(requests[0]!.init.body)),called=JSON.parse(String(requests[1]!.init.body));
 assert.equal(near.type,'template');assert.equal(near.template.name,'qevra_near');assert.equal(near.template.language.code,'id');
 assert.deepEqual(near.template.components[0].parameters.map((p:{text:string})=>p.text),['Branch','Customer','P001','3']);
 assert.equal(called.template.name,'qevra_called');assert.equal(called.template.components[0].parameters.length,3);
 assert.equal(near.biz_opaque_callback_data,delivery.dedupeKey);assert.equal(near.text,undefined);
 assert.equal(requests[0]!.init.redirect,'error');
});
test('Meta transport is never invoked for absent consent, invalid destination, disabled mode or unsupported type',async()=>{
 const transport=async()=>{assert.fail('Unexpected transport call');};
 const provider=new MetaWhatsAppProvider(config,transport);
 for(const override of [{consented:false},{phone:null},{phone:'+12025550123'},{template:undefined}])assert.equal((await provider.send({...delivery,...override})).status,'SKIPPED');
 assert.equal((await new MetaWhatsAppProvider({...config,mode:'DISABLED'},transport).send(delivery)).status,'SKIPPED');
});
test('Meta uncertainty is not retried; only explicit throttling rejection is retryable',async()=>{
 const cases:[number,unknown,string][]=[[400,{error:{code:130429}},'RETRY'],[400,{error:{code:131056}},'RETRY'],
 [401,{error:{code:190}},'FAILED'],[500,{error:{code:131000}},'AMBIGUOUS'],[200,{},'AMBIGUOUS']];
 for(const [status,body,outcome]of cases)await assert.rejects(new MetaWhatsAppProvider(config,async()=>Response.json(body,{status})).send(delivery),e=>e instanceof DeliveryError&&e.outcome===outcome);
 await assert.rejects(new MetaWhatsAppProvider(config,async()=>{throw new Error('secret transport details');}).send(delivery),e=>e instanceof DeliveryError&&e.code==='TRANSPORT_UNCERTAIN'&&!e.message.includes('secret'));
 assert.deepEqual([1,2,3,4,5,6,20].map(retryDelaySeconds),[5,10,20,40,80,120,120]);
});
function payload(status='delivered',phone='123456'){
 return {object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:phone},
 statuses:[{id:'wamid.fixture',status,timestamp:'1800000000',recipient_id:'not-persisted',biz_opaque_callback_data:delivery.dedupeKey}]}}]}]};
}
test('receipt parsing is sender-scoped, deduplicable and excludes recipient/raw content',()=>{
 const parsed=parseReceipts(payload(),'123456');assert.equal(parsed.length,1);assert.equal(parsed[0]!.callbackId,delivery.dedupeKey);
 assert.deepEqual(parseReceipts(payload(),'other'),[]);assert.deepEqual(parseReceipts(payload('unknown'),'123456'),[]);
 assert.equal(parsed[0]!.hash,parseReceipts(payload(),'123456')[0]!.hash);assert.ok(!JSON.stringify(parsed).includes('not-persisted'));
 const raw=Buffer.from(JSON.stringify(payload())),signature='sha256='+createHmac('sha256','fixture-secret').update(raw).digest('hex');
 assert.equal(verifySignature(raw,signature,'fixture-secret'),true);
 assert.equal(verifySignature(Buffer.concat([raw,Buffer.from(' ')]),signature,'fixture-secret'),false);
 assert.equal(verifySignature(raw,undefined,'fixture-secret'),false);
});
test('webhook challenge and raw signature validation precede JSON parsing and persistence',async()=>{
 let writes=0;
 const app=express();app.use('/hook',createWhatsAppWebhook(config,async op=>op({query:async()=>{writes++;return {rows:[]};}} as unknown as PoolClient)));
 app.use(express.json());
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/hook';
 try{
   const ok=await fetch(base+'?hub.mode=subscribe&hub.verify_token=fixture-verify&hub.challenge=123');assert.equal(ok.status,200);assert.equal(await ok.text(),'123');
   assert.equal((await fetch(base+'?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status,403);
   const raw=JSON.stringify(payload()),sig='sha256='+createHmac('sha256','fixture-secret').update(raw).digest('hex');
   assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:raw})).status,401);assert.equal(writes,0);
   assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':sig},body:raw+' '})).status,401);assert.equal(writes,0);
   assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':sig},body:raw})).status,200);assert.ok(writes>0);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('worker invokes transport only after prepare commits, and never sends skipped jobs',async()=>{
 const job:Job={id:randomUUID(),business_id:randomUUID(),notification_id:randomUUID(),claim_token:randomUUID(),attempts:1};
 let committed=false,sends=0;
 class Worker extends WhatsAppOutbox {
   override async claim(){return job;}
   override async prepare():Promise<NotificationDelivery|null>{committed=true;return delivery;}
 }
 const c={query:async(sql:string)=>({rows:sql.includes('SELECT status,claim_token')?[{status:'ACCEPTED',claim_token:job.claim_token}]:[]})} as unknown as PoolClient;
 const worker=new Worker(async op=>op(c),{channel:'META_WHATSAPP',send:async()=>{assert.ok(committed);sends++;return {status:'SENT',providerMessageId:'wamid.fixture'};}});
 await worker.tick();assert.equal(sends,1);
 worker.prepare=async()=>null;await worker.tick();assert.equal(sends,1);
});
