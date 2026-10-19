import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {Router,urlencoded} from 'express';
import {z} from 'zod';
import type {WhatsAppConfiguration} from '../../config/whatsapp.js';
import type {TransactionRunner} from '../configuration/routes.js';
import {storeReceipts,type Receipt} from './outbox.js';
import {TWILIO_WEBHOOK_PATH,validMobile,verifyInbound} from './twilio-provider.js';

// Twilio form signature: exact public URL + ALL sorted POST fields, HMAC-SHA1.
// Duplicate/non-string fields are rejected, not ambiguously canonicalized.
export function validTwilioSignature(url:string,body:Record<string,unknown>,signature:string|undefined,token:string):boolean{
  if(!signature||Object.values(body).some(v=>typeof v!=='string'))return false;
  const input=url+Object.keys(body).sort().map(k=>k+body[k]).join('');
  const expected=createHmac('sha1',token).update(input).digest('base64');
  const actual=Buffer.from(signature);
  return actual.length===Buffer.byteLength(expected)&&timingSafeEqual(actual,Buffer.from(expected));
}
export function createTwilioWebhook(config:WhatsAppConfiguration,run:TransactionRunner,inbound=verifyInbound):Router{
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');if(config.mode!=='TWILIO'){res.sendStatus(404);return;}next();});
  router.use(urlencoded({extended:false,limit:'32kb',parameterLimit:100}));
  router.use((req,res,next)=>{
    if(req.method!=='POST'||!req.is('application/x-www-form-urlencoded')||!req.body||
      !validTwilioSignature(config.TWILIO_WEBHOOK_ORIGIN+req.originalUrl,req.body,req.get('X-Twilio-Signature'),config.TWILIO_AUTH_TOKEN!)||
      req.body.AccountSid!==config.TWILIO_ACCOUNT_SID){res.sendStatus(403);return;}next();
  });
  router.post('/inbound',async(req,res)=>{
    const b=req.body as Record<string,string>,phone=(b.From??'').replace(/^whatsapp:/,'');
    if(req.originalUrl!==TWILIO_WEBHOOK_PATH+'/inbound'||b.To!==config.TWILIO_WHATSAPP_FROM||!validMobile(phone)||!/^SM[0-9a-fA-F]{32}$/.test(b.MessageSid??'')){res.sendStatus(400);return;}
    // Provider HTTP completes before opening a database transaction. No auto-reply.
    const at=await inbound(config,b.MessageSid!,phone);
    await run(c=>c.query(`INSERT INTO public.twilio_inbound_messages(account_sid,message_sid,sender,phone_e164,sent_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[config.TWILIO_ACCOUNT_SID,b.MessageSid,config.TWILIO_WHATSAPP_FROM,phone,at]));
    res.type('text/xml').send('<Response/>');
  });
  router.post('/status',async(req,res)=>{
    const b=req.body as Record<string,string>,job=z.uuid().safeParse(req.query.job);
    if(!job.success||req.originalUrl!==TWILIO_WEBHOOK_PATH+'/status?job='+job.data||b.From!==config.TWILIO_WHATSAPP_FROM||!/^SM[0-9a-fA-F]{32}$/.test(b.MessageSid??'')){res.sendStatus(400);return;}
    const mapping:Record<string,Receipt['status']>={sent:'sent',delivered:'delivered',read:'read',failed:'failed',undelivered:'failed',canceled:'failed'};
    const status=mapping[b.MessageStatus??''];
    if(!status){res.sendStatus(204);return;}
    const code=/^\d{1,10}$/.test(b.ErrorCode??'')?'TWILIO_'+b.ErrorCode:null;
    const r:Receipt={messageId:b.MessageSid!,callbackId:job.data,status,timestamp:'0',code,
      hash:createHash('sha256').update(JSON.stringify(['TWILIO',config.TWILIO_ACCOUNT_SID,b.MessageSid,status,code])).digest('hex')};
    await run(c=>storeReceipts(c,[r],'TWILIO_WHATSAPP'));res.sendStatus(204);
  });
  return router;
}
