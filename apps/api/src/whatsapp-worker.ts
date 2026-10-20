import {setTimeout as delay} from 'node:timers/promises';
import {env,whatsapp} from './config/env.js';
import {assertProductionReady} from './config/production.js';
import {withTransaction} from './db/transaction.js';
import {closePool} from './db/client.js';
import {logDatabaseFailure} from './db/diagnostics.js';
import {MetaWhatsAppProvider} from './modules/notifications/meta-provider.js';
import {WhatsAppOutbox} from './modules/notifications/outbox.js';
import {TwilioWhatsAppProvider} from './modules/notifications/twilio-provider.js';

assertProductionReady(env);
if(!['META','TWILIO'].includes(whatsapp.mode)||!env.DATABASE_URL)throw new Error('WhatsApp worker requires META or TWILIO provider and database configuration.');
let stopping=false;
const wake=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{stopping=true;wake.abort();});
const provider=whatsapp.mode==='TWILIO'?new TwilioWhatsAppProvider(whatsapp,phone=>withTransaction(async c=>{
  const row=(await c.query(`SELECT max(sent_at) AS last_inbound FROM public.twilio_inbound_messages
    WHERE account_sid=$1 AND sender=$2 AND phone_e164=$3`,[whatsapp.TWILIO_ACCOUNT_SID,whatsapp.TWILIO_WHATSAPP_FROM,phone])).rows[0];
  return row?.last_inbound??null;
})):new MetaWhatsAppProvider(whatsapp);
const worker=new WhatsAppOutbox(withTransaction,provider);
console.log('WhatsApp outbox worker started.');
try{
  while(!stopping){
    try{if(await worker.tick())continue;}
    catch(error){logDatabaseFailure('worker',error);}
    await delay(2000,undefined,{signal:wake.signal}).catch(()=>{});
  }
}finally{await closePool();console.log('WhatsApp outbox worker stopped.');}
