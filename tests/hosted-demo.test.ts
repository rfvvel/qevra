import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {PoolClient} from 'pg';
import {rootCertificates} from 'node:tls';
import {randomUUID} from 'node:crypto';
import {customerJoinSchema} from '@qevra/contracts';
import {whatsappConfiguration} from '../apps/api/src/config/whatsapp.js';
import {databaseOptions} from '../apps/api/src/config/database.js';
import {assertProductionReady} from '../apps/api/src/config/production.js';

const fixture={NODE_ENV:'production',WHATSAPP_PROVIDER:'TWILIO',TWILIO_ACCOUNT_SID:'AC'+'1'.repeat(32),TWILIO_AUTH_TOKEN:'fixture',TWILIO_WHATSAPP_FROM:'whatsapp:+15005550006',TWILIO_WEBHOOK_ORIGIN:'https://api.example.test'};
test('hosted flag is explicit, defaults closed and only unlocks Twilio selection',()=>{
 for(const flag of [undefined,'false','TRUE','1'])assert.throws(()=>whatsappConfiguration({...fixture,TWILIO_HOSTED_DEMO_ENABLED:flag}));
 assert.equal(whatsappConfiguration({...fixture,TWILIO_HOSTED_DEMO_ENABLED:'true'}).mode,'TWILIO');
 assert.throws(()=>whatsappConfiguration({...fixture,TWILIO_HOSTED_DEMO_ENABLED:'true',TWILIO_AUTH_TOKEN:undefined}),/Missing/);
 assert.equal(whatsappConfiguration({NODE_ENV:'production',TWILIO_HOSTED_DEMO_ENABLED:'true'}).mode,'DISABLED');
 assert.equal(whatsappConfiguration({NODE_ENV:'production',WHATSAPP_PROVIDER:'MOCK',TWILIO_HOSTED_DEMO_ENABLED:'true'}).mode,'DISABLED');
 assert.throws(()=>assertProductionReady({NODE_ENV:'production',WEB_ORIGIN:'http://localhost'}));
});
test('production TLS is portable and cannot be downgraded by URL parameters',()=>{
 const base={NODE_ENV:'production',DATABASE_URL:'postgresql://user:fixture@db.example.test/postgres?sslmode=verify-full'};
 const options=databaseOptions(base);
 assert.deepEqual(options.ssl,{rejectUnauthorized:true});assert.ok(!options.connectionString!.includes('sslmode'));
 for(const query of ['sslmode=disable','sslmode=verify-full&ssl=false','sslmode=verify-full&sslrootcert=C%3A%2Fprivate.crt','sslmode=verify-full&sslmode=no-verify','sslmode=verify-full&uselibpqcompat=true','sslmode=verify-full&host=other'])
  assert.throws(()=>databaseOptions({...base,DATABASE_URL:'postgresql://db.example.test/postgres?'+query}));
 assert.throws(()=>databaseOptions({...base,DATABASE_CA_CERT:'C:\\private.crt'}),/valid PEM/);
 const cert=rootCertificates[0]!;
 assert.deepEqual(databaseOptions({...base,DATABASE_CA_CERT:cert.replace(/\n/g,'\\n')}).ssl,{rejectUnauthorized:true,ca:cert.trim()});
});
test('hosted production preserves open public branch access, arbitrary valid join phones and disabled mock payments',async()=>{
 Object.assign(process.env,fixture,{TWILIO_HOSTED_DEMO_ENABLED:'true',PAYMENT_PROVIDER:'MOCK',MOCK_WHATSAPP_ENABLED:'true'});
 const {createApp}=await import('../apps/api/src/app.js');
 const client={query:async(sql:string)=>({rows:sql.includes('SELECT br.id')?[{id:randomUUID(),business_id:randomUUID(),business_name:'Demo',name:'Public',public_slug:'public-demo',address:null,timezone:'Asia/Jakarta'}]:[]})} as unknown as PoolClient;
 const server=createApp({runTransaction:async op=>op(client)}).listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1';
 try{
  const response=await fetch(base+'/public/branches/public-demo');assert.equal(response.status,200);assert.equal((await response.json()).branch.public_slug,'public-demo');
  for(let i=0;i<20;i++)assert.equal(customerJoinSchema.safeParse({branchSlug:'public-demo',serviceId:randomUUID(),customerName:'Visitor '+i,phone:'+628123456'+String(i).padStart(4,'0'),whatsappOptIn:true}).success,true);
  for(const path of ['/payments/'+randomUUID()+'/mock','/join-requests/'+randomUUID()+'/payments'])assert.equal((await fetch(base+'/customer'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  const {mockPaymentsEnabled,mockWhatsAppEnabled}=await import('../apps/api/src/config/env.js');assert.equal(mockPaymentsEnabled,false);assert.equal(mockWhatsAppEnabled,false);
  // A persistence failure is contained by the notification savepoint, not the queue transaction.
  const {NotificationService}=await import('../apps/api/src/modules/notifications/service.js');const sqls:string[]=[];
  const failed={query:async(sql:string)=>{sqls.push(sql);if(sql.includes('SELECT t.id'))throw new Error('simulated failure');return {rows:[]};}} as unknown as PoolClient;
  await new NotificationService().handleQueueEvent(failed,{businessId:randomUUID(),branchId:randomUUID(),serviceId:randomUUID(),businessDate:'2026-10-19',timezone:'Asia/Jakarta',serviceName:'Demo',branchName:'Public',prefix:'A',businessActive:true,branchActive:true,serviceActive:true,paymentMode:'NONE',price:'0'},{id:randomUUID(),name:'TICKET_CALLED',ticketId:randomUUID(),sessionId:randomUUID()});
  assert.ok(sqls.includes('ROLLBACK TO SAVEPOINT notification_generation'));assert.ok(sqls.some(sql=>sql.includes('GENERATION_FAILED')));assert.ok(!sqls.includes('ROLLBACK'));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
