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

export type InboundVerificationCode =
  'INPUT_INVALID' | 'HTTP_401' | 'HTTP_403' | 'HTTP_404' | 'HTTP_429' | 'HTTP_5XX' | 'HTTP_OTHER' |
  'TRANSPORT_TIMEOUT' | 'TRANSPORT_DNS' | 'TRANSPORT_TLS' | 'TRANSPORT_NETWORK' |
  'RESPONSE_JSON' | 'RESPONSE_SHAPE' | 'SID_MISMATCH' | 'ACCOUNT_MISMATCH' |
  'DIRECTION_MISMATCH' | 'SENDER_MISMATCH' | 'RECIPIENT_MISMATCH' |
  'TIMESTAMP_INVALID' | 'TIMESTAMP_FUTURE';
export class InboundVerificationError extends Error {
  constructor(readonly code:InboundVerificationCode){
    super('Twilio inbound verification failed or identity mismatch.');
  }
}
function transportFailure(error:unknown):InboundVerificationError{
  const seen=new Set<object>();
  let item=error;
  for(let i=0;i<5&&item&&typeof item==='object'&&!seen.has(item);i++){
    seen.add(item);
    const e=item as {name?:unknown;code?:unknown;cause?:unknown};
    if(e.name==='TimeoutError'||e.name==='AbortError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(String(e.code)))
      return new InboundVerificationError('TRANSPORT_TIMEOUT');
    if(e.code==='ENOTFOUND'||e.code==='EAI_AGAIN')return new InboundVerificationError('TRANSPORT_DNS');
    if(['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(String(e.code)))
      return new InboundVerificationError('TRANSPORT_TLS');
    item=e.cause;
  }
  return new InboundVerificationError('TRANSPORT_NETWORK');
}

// Signed callbacks do not supply a trusted original message timestamp. Retrieve the
// actual inbound resource so delayed/replayed callbacks cannot open a fresh window.
export async function verifyInbound(c:WhatsAppConfiguration,sid:string,phone:string,transport:MetaTransport=fetch):Promise<Date>{
  if(!/^SM[0-9a-fA-F]{32}$/.test(sid)||!validMobile(phone))throw new InboundVerificationError('INPUT_INVALID');
  let response:Response;
  try{
    response=await transport(twilioMessagesUrl(c)+'/'+sid+'.json',{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:twilioAuthorization(c)}});
  }catch(error){throw transportFailure(error);}
  if(!response.ok){
    // Do not parse provider error bodies, which can include identifiers or URLs.
    await response.body?.cancel().catch(()=>{});
    const code:InboundVerificationCode=response.status===401?'HTTP_401':response.status===403?'HTTP_403':
      response.status===404?'HTTP_404':response.status===429?'HTTP_429':response.status>=500?'HTTP_5XX':'HTTP_OTHER';
    throw new InboundVerificationError(code);
  }
  let raw:unknown;
  try{raw=await response.json();}
  catch(error){
    if(error instanceof SyntaxError)throw new InboundVerificationError('RESPONSE_JSON');
    throw transportFailure(error);
  }
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new InboundVerificationError('RESPONSE_SHAPE');
  const data=raw as Record<string,unknown>;
  if(data.sid!==sid)throw new InboundVerificationError('SID_MISMATCH');
  if(data.account_sid!==c.TWILIO_ACCOUNT_SID)throw new InboundVerificationError('ACCOUNT_MISMATCH');
  if(data.direction!=='inbound')throw new InboundVerificationError('DIRECTION_MISMATCH');
  if(data.from!=='whatsapp:'+phone)throw new InboundVerificationError('SENDER_MISMATCH');
  if(data.to!==c.TWILIO_WHATSAPP_FROM)throw new InboundVerificationError('RECIPIENT_MISMATCH');
  // Raw REST JSON uses snake_case and an RFC 2822 string, not SDK camelCase or epoch numbers.
  if(typeof data.date_created!=='string'||!data.date_created.trim())throw new InboundVerificationError('TIMESTAMP_INVALID');
  const at=new Date(data.date_created);
  if(!Number.isFinite(at.getTime()))throw new InboundVerificationError('TIMESTAMP_INVALID');
  if(at.getTime()>Date.now())throw new InboundVerificationError('TIMESTAMP_FUTURE');
  return at;
}
