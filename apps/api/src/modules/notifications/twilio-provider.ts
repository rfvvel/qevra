import type {WhatsAppConfiguration} from '../../config/whatsapp.js';
import type {NotificationDelivery,NotificationProvider,DeliveryResult} from './provider.js';
import {DeliveryError,type MetaTransport} from './meta-provider.js';

export const TWILIO_WEBHOOK_PATH='/api/v1/webhooks/twilio';
export const validMobile=(phone:string)=>/^\+628[0-9]{7,11}$/.test(phone);
// A margin avoids deliberately sending right at the provider's 24-hour boundary.
export function windowOpen(lastInbound:Date|null,now=Date.now()):boolean{
  const at=lastInbound?.getTime();
  return at!==undefined&&Number.isFinite(at)&&at<=now&&now-at<24*60*60*1000-60*1000;
}
export type WindowLookup=(phone:string)=>Promise<Date|null>;
export class TwilioWhatsAppProvider implements NotificationProvider {
  readonly channel='TWILIO_WHATSAPP';
  constructor(private readonly config:WhatsAppConfiguration,private readonly lastInbound:WindowLookup,
    private readonly transport:MetaTransport=fetch,private readonly now=()=>Date.now()){}
  async send(delivery:NotificationDelivery):Promise<DeliveryResult>{
    if(this.config.mode!=='TWILIO')return {status:'SKIPPED',code:'PROVIDER_DISABLED'};
    if(!delivery.consented||!delivery.phone)return {status:'SKIPPED',code:'NO_CONSENT'};
    if(!validMobile(delivery.phone))return {status:'SKIPPED',code:'UNSUPPORTED_PHONE'};
    const t=delivery.template;
    if(!t||!['NEAR_TURN','YOUR_TURN'].includes(t.type))return {status:'SKIPPED',code:'UNSUPPORTED_TYPE'};
    if(!windowOpen(await this.lastInbound(delivery.phone),this.now()))return {status:'SKIPPED',code:'TWILIO_WINDOW_CLOSED'};
    const clean=(s:string)=>s.replace(/[\r\n\t]+/g,' ').trim().slice(0,160);
    const body=`Info antrean ${clean(t.branchName)}: Halo ${clean(t.customerName)}, nomor antrean Anda ${clean(t.queueNumber)}. `+
      (t.type==='NEAR_TURN'?`Ada ${t.peopleAhead} pelanggan menunggu di depan Anda. Mohon tetap dekat area layanan.`:
        'Anda sedang dipanggil. Silakan menuju area layanan.')+' Pantau halaman antrean Qevra.';
    const form=new URLSearchParams({From:this.config.TWILIO_WHATSAPP_FROM!,To:'whatsapp:'+delivery.phone,Body:body,
      StatusCallback:this.config.TWILIO_WEBHOOK_ORIGIN+TWILIO_WEBHOOK_PATH+'/status?job='+encodeURIComponent(delivery.dedupeKey)});
    let response:Response,data:{sid?:string;code?:number;status?:string};
    try{
      response=await this.transport(twilioMessagesUrl(this.config)+'.json',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
        headers:{Authorization:twilioAuthorization(this.config),'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
      data=await response.json() as typeof data;
    }catch{throw new DeliveryError('AMBIGUOUS','TWILIO_TRANSPORT_UNCERTAIN');}
    if(response.ok){
      if(!/^SM[0-9a-fA-F]{32}$/.test(data?.sid??''))throw new DeliveryError('AMBIGUOUS','TWILIO_ACCEPTANCE_UNCERTAIN');
      if(['failed','undelivered','canceled'].includes(data.status??''))throw new DeliveryError('FAILED','TWILIO_REJECTED');
      return {status:'SENT',providerMessageId:data.sid};
    }
    if(response.status===429&&data?.code===20429)throw new DeliveryError('RETRY','TWILIO_RATE_LIMIT');
    if(response.status>=500)throw new DeliveryError('AMBIGUOUS','TWILIO_SERVER_UNCERTAIN');
    throw new DeliveryError('FAILED',Number.isSafeInteger(data?.code)&&data.code!>=0?'TWILIO_'+data.code:'TWILIO_REJECTED');
  }
}
export const twilioMessagesUrl=(c:WhatsAppConfiguration)=>'https://api.twilio.com/2010-04-01/Accounts/'+c.TWILIO_ACCOUNT_SID+'/Messages';
export const twilioAuthorization=(c:WhatsAppConfiguration)=>'Basic '+Buffer.from(c.TWILIO_ACCOUNT_SID+':'+c.TWILIO_AUTH_TOKEN).toString('base64');

// Signed callbacks do not supply a trusted original message timestamp. Retrieve the
// actual inbound resource so delayed/replayed callbacks cannot open a fresh window.
export async function verifyInbound(c:WhatsAppConfiguration,sid:string,phone:string,transport:MetaTransport=fetch):Promise<Date>{
  if(!/^SM[0-9a-fA-F]{32}$/.test(sid)||!validMobile(phone))throw new Error('Invalid inbound identity.');
  let data:{sid?:string;account_sid?:string;direction?:string;from?:string;to?:string;date_created?:string};
  try{
    const response=await transport(twilioMessagesUrl(c)+'/'+sid+'.json',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:twilioAuthorization(c)}});
    if(!response.ok)throw new Error('Unavailable');
    data=await response.json() as typeof data;
  }catch{throw new Error('Twilio inbound verification unavailable.');}
  const at=new Date(data?.date_created??'');
  if(data?.sid!==sid||data.account_sid!==c.TWILIO_ACCOUNT_SID||data.direction!=='inbound'||
    data.from!=='whatsapp:'+phone||data.to!==c.TWILIO_WHATSAPP_FROM||!Number.isFinite(at.getTime())||at.getTime()>Date.now())throw new Error('Twilio inbound identity mismatch.');
  return at;
}
