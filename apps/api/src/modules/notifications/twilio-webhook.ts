import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {Router,urlencoded,type Response} from 'express';
import {z} from 'zod';
import type {WhatsAppConfiguration} from '../../config/whatsapp.js';
import type {TransactionRunner} from '../configuration/routes.js';
import {storeReceipts,type Receipt} from './outbox.js';
import {TWILIO_WEBHOOK_PATH,validMobile,verifyInbound,InboundVerificationError} from './twilio-provider.js';
import {databaseDiagnostic} from '../../db/diagnostics.js';

type Rejection = 'METHOD' | 'CONTENT_TYPE' | 'FORM_FIELDS' | 'SIGNATURE' | 'ACCOUNT' |
  'INBOUND_URL' | 'DESTINATION' | 'SENDER' | 'MESSAGE_SID' | 'STATUS_PAYLOAD' |
  'BODY_PARSE' | 'BODY_LIMIT' | 'BODY_ENCODING' | 'INBOUND_VERIFICATION' | 'DATABASE';
// Only locally defined codes and sanitized database categories are logged.
function reject(res:Response,status:number,code:Rejection,error?:unknown):void{
  console.error(JSON.stringify({event:'twilio_webhook_rejected',code,
    ...(code==='INBOUND_VERIFICATION'?{reason:error instanceof InboundVerificationError?error.code:'UNKNOWN'}:{}),
    ...(code==='DATABASE'?{database:databaseDiagnostic(error)}:{})}));
  res.status(status).json({error:{code:'TWILIO_'+code}});
}

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
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Qevra-Webhook','twilio-v1');if(config.mode!=='TWILIO'){res.sendStatus(404);return;}next();});
  router.use((req,res,next)=>{
    if(req.method!=='POST'){reject(res,405,'METHOD');return;}
    if(!req.is('application/x-www-form-urlencoded')){reject(res,415,'CONTENT_TYPE');return;}
    next();
  });
  const parse=urlencoded({extended:false,limit:'32kb',parameterLimit:100});
  router.use((req,res,next)=>parse(req,res,(error?:unknown)=>{
    if(!error){next();return;}
    const type=typeof error==='object'&&error!==null&&'type' in error?error.type:undefined;
    if(type==='entity.too.large'||type==='parameters.too.many'){reject(res,413,'BODY_LIMIT');return;}
    if(type==='charset.unsupported'||type==='encoding.unsupported'){reject(res,415,'BODY_ENCODING');return;}
    reject(res,400,'BODY_PARSE');
  }));
  router.use((req,res,next)=>{
    if(!req.body||typeof req.body!=='object'||Object.values(req.body).some(v=>typeof v!=='string')){reject(res,400,'FORM_FIELDS');return;}
    if(!validTwilioSignature(config.TWILIO_WEBHOOK_ORIGIN+req.originalUrl,req.body,req.get('X-Twilio-Signature'),config.TWILIO_AUTH_TOKEN!)){reject(res,403,'SIGNATURE');return;}
    if(req.body.AccountSid!==config.TWILIO_ACCOUNT_SID){reject(res,403,'ACCOUNT');return;}
    next();
  });
  router.post('/inbound',async(req,res)=>{
    const b=req.body as Record<string,string>,phone=(b.From??'').replace(/^whatsapp:/,'');
    if(req.originalUrl!==TWILIO_WEBHOOK_PATH+'/inbound'){reject(res,400,'INBOUND_URL');return;}
    if(b.To!==config.TWILIO_WHATSAPP_FROM){reject(res,400,'DESTINATION');return;}
    if(!b.From?.startsWith('whatsapp:')||!validMobile(phone)){reject(res,400,'SENDER');return;}
    if(!/^SM[0-9a-fA-F]{32}$/.test(b.MessageSid??'')){reject(res,400,'MESSAGE_SID');return;}
    // Provider HTTP completes before opening a database transaction. No auto-reply.
    let at:Date;
    try{at=await inbound(config,b.MessageSid!,phone);}
    catch(error){reject(res,502,'INBOUND_VERIFICATION',error);return;}
    try{
      await run(c=>c.query(`INSERT INTO public.twilio_inbound_messages(account_sid,message_sid,sender,phone_e164,sent_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[config.TWILIO_ACCOUNT_SID,b.MessageSid,config.TWILIO_WHATSAPP_FROM,phone,at]));
    }catch(error){reject(res,503,'DATABASE',error);return;}
    res.type('text/xml').send('<Response/>');
  });
  router.post('/status',async(req,res)=>{
    const b=req.body as Record<string,string>,job=z.uuid().safeParse(req.query.job);
    if(!job.success||req.originalUrl!==TWILIO_WEBHOOK_PATH+'/status?job='+job.data||b.From!==config.TWILIO_WHATSAPP_FROM||!/^SM[0-9a-fA-F]{32}$/.test(b.MessageSid??'')){reject(res,400,'STATUS_PAYLOAD');return;}
    const mapping:Record<string,Receipt['status']>={sent:'sent',delivered:'delivered',read:'read',failed:'failed',undelivered:'failed',canceled:'failed'};
    const status=mapping[b.MessageStatus??''];
    if(!status){res.sendStatus(204);return;}
    const code=/^\d{1,10}$/.test(b.ErrorCode??'')?'TWILIO_'+b.ErrorCode:null;
    const r:Receipt={messageId:b.MessageSid!,callbackId:job.data,status,timestamp:'0',code,
      hash:createHash('sha256').update(JSON.stringify(['TWILIO',config.TWILIO_ACCOUNT_SID,b.MessageSid,status,code])).digest('hex')};
    try{await run(c=>storeReceipts(c,[r],'TWILIO_WHATSAPP'));}
    catch(error){reject(res,503,'DATABASE',error);return;}
    res.sendStatus(204);
  });
  return router;
}
