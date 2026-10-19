import type {WhatsAppConfiguration} from '../../config/whatsapp.js';
import type {NotificationDelivery,NotificationProvider,DeliveryResult} from './provider.js';

export class DeliveryError extends Error {
  constructor(public readonly outcome:'RETRY'|'FAILED'|'AMBIGUOUS',public readonly code:string){super(code);}
}
export type MetaTransport=(url:string,init:RequestInit)=>Promise<Response>;
export class MetaWhatsAppProvider implements NotificationProvider {
  readonly channel='META_WHATSAPP';
  constructor(private readonly config:WhatsAppConfiguration,private readonly transport:MetaTransport=fetch){}
  async send(delivery:NotificationDelivery):Promise<DeliveryResult>{
    if(this.config.mode!=='META')return {status:'SKIPPED',code:'PROVIDER_DISABLED'};
    if(!delivery.consented||!delivery.phone)return {status:'SKIPPED',code:'NO_CONSENT'};
    if(!/^\+628[0-9]{7,11}$/.test(delivery.phone))return {status:'SKIPPED',code:'UNSUPPORTED_PHONE'};
    const t=delivery.template;
    if(!t||!['NEAR_TURN','YOUR_TURN'].includes(t.type))return {status:'SKIPPED',code:'UNSUPPORTED_TYPE'};
    const clean=(v:string)=>v.replace(/[\r\n\t]+/g,' ').trim().slice(0,160);
    const parameters=[t.branchName,t.customerName,t.queueNumber,...(t.type==='NEAR_TURN'?[String(t.peopleAhead)]:[])].map(text=>({type:'text',text:clean(text)}));
    const body={messaging_product:'whatsapp',recipient_type:'individual',to:delivery.phone.slice(1),type:'template',
      biz_opaque_callback_data:delivery.dedupeKey,
      template:{name:t.type==='NEAR_TURN'?this.config.META_WHATSAPP_NEAR_TURN_TEMPLATE:this.config.META_WHATSAPP_YOUR_TURN_TEMPLATE,
        language:{code:this.config.META_WHATSAPP_TEMPLATE_LANGUAGE},components:[{type:'body',parameters}]}};
    let response:Response,data:{messages?:{id?:string}[];error?:{code?:number}};
    try{
      response=await this.transport('https://graph.facebook.com/'+this.config.META_WHATSAPP_API_VERSION+'/'+this.config.META_WHATSAPP_PHONE_NUMBER_ID+'/messages',{
        method:'POST',redirect:'error',headers:{Authorization:'Bearer '+this.config.META_WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      data=await response.json() as typeof data;
    }catch{throw new DeliveryError('AMBIGUOUS','TRANSPORT_UNCERTAIN');}
    if(response.ok){
      const id=data?.messages?.[0]?.id;
      if(typeof id!=='string'||!id.length||id.length>250)throw new DeliveryError('AMBIGUOUS','ACCEPTANCE_UNCERTAIN');
      return {status:'SENT',providerMessageId:id}; // Accepted by Meta, not proof of delivery.
    }
    const code=data?.error?.code;
    // Retry only explicit rejection/throttling. Unknown/5xx outcomes may have sent.
    if(response.status<500&&[4,80007,130429,131056].includes(code??-1))throw new DeliveryError('RETRY','META_RATE_LIMIT');
    if(response.status>=500)throw new DeliveryError('AMBIGUOUS','META_SERVER_UNCERTAIN');
    throw new DeliveryError('FAILED',Number.isSafeInteger(code)?'META_'+code:'META_REJECTED');
  }
}
