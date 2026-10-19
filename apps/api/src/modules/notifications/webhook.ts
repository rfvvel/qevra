import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Router,raw} from 'express';
import {z} from 'zod';
import type {WhatsAppConfiguration} from '../../config/whatsapp.js';
import type {TransactionRunner} from '../configuration/routes.js';
import {storeReceipts,type Receipt} from './outbox.js';

const statusSchema=z.object({id:z.string().min(1).max(250),status:z.enum(['sent','delivered','read','failed']),
  timestamp:z.string().regex(/^\d{1,12}$/),biz_opaque_callback_data:z.string().max(512).optional(),
  errors:z.array(z.object({code:z.number().int().nonnegative()})).max(20).optional()});
const payloadSchema=z.object({object:z.literal('whatsapp_business_account'),entry:z.array(z.object({
  changes:z.array(z.object({field:z.string(),value:z.object({metadata:z.object({phone_number_id:z.string()}).optional(),
    statuses:z.array(z.unknown()).max(200).optional()})})).max(100)})).max(100)});
export function verifySignature(body:Buffer,signature:string|undefined,secret:string):boolean{
  if(!/^sha256=[a-f0-9]{64}$/.test(signature??''))return false;
  return timingSafeEqual(createHmac('sha256',secret).update(body).digest(),Buffer.from(signature!.slice(7),'hex'));
}
export function parseReceipts(body:unknown,phoneId:string):Receipt[]{
  const payload=payloadSchema.parse(body),receipts:Receipt[]=[];
  for(const entry of payload.entry)for(const change of entry.changes){
    if(change.field!=='messages'||change.value.metadata?.phone_number_id!==phoneId)continue;
    for(const rawStatus of change.value.statuses??[]){
      const parsed=statusSchema.safeParse(rawStatus);if(!parsed.success)continue;
      const s=parsed.data,callback=z.uuid().safeParse(s.biz_opaque_callback_data);
      const code=s.errors?.[0]?.code;
      const key=[phoneId,s.id,s.status,s.timestamp,code??null];
      receipts.push({hash:createHash('sha256').update(JSON.stringify(key)).digest('hex'),messageId:s.id,
        callbackId:callback.success?callback.data:null,status:s.status,timestamp:s.timestamp,code:code===undefined?null:'META_'+code});
    }
  }
  return receipts;
}
export function createWhatsAppWebhook(config:WhatsAppConfiguration,run:TransactionRunner):Router{
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');if(config.mode!=='META'){res.sendStatus(404);return;}next();});
  router.get('/',(req,res)=>{
    const token=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];
    if(req.query['hub.mode']!=='subscribe'||typeof token!=='string'||typeof challenge!=='string'||!/^\d{1,100}$/.test(challenge)){
      res.sendStatus(403);return;
    }
    const digest=(s:string)=>createHash('sha256').update(s).digest();
    if(!timingSafeEqual(digest(token),digest(config.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN!))){res.sendStatus(403);return;}
    res.type('text/plain').send(challenge);
  });
  router.post('/',raw({type:'application/json',limit:'256kb',inflate:false}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||!verifySignature(req.body,req.get('X-Hub-Signature-256'),config.META_WHATSAPP_APP_SECRET!)){
      res.sendStatus(401);return;
    }
    let receipts:Receipt[];
    try{receipts=parseReceipts(JSON.parse(req.body.toString('utf8')),config.META_WHATSAPP_PHONE_NUMBER_ID!);}
    catch{res.sendStatus(400);return;}
    // Respond only after durable storage; DB failures propagate a sanitized 500 so Meta retries.
    await run(c=>storeReceipts(c,receipts));res.sendStatus(200);
  });
  return router;
}
