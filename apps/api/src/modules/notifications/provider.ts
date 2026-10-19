import {mockWhatsAppEnabled} from '../../config/env.js';
export interface NotificationDelivery {title:string;message:string;phone:string|null;consented:boolean;dedupeKey:string;
  template?:{type:'NEAR_TURN'|'YOUR_TURN';branchName:string;customerName:string;queueNumber:string;peopleAhead:number};}
export interface DeliveryResult {status:'SENT'|'SKIPPED';recipientMasked?:string;code?:string;providerMessageId?:string;}
export interface NotificationProvider {readonly channel:'IN_APP'|'MOCK_WHATSAPP'|'META_WHATSAPP'|'TWILIO_WHATSAPP';send(delivery:NotificationDelivery):Promise<DeliveryResult>;}
export class InAppNotificationProvider implements NotificationProvider {
  readonly channel='IN_APP';
  async send():Promise<DeliveryResult>{return {status:'SENT'};}
}
export function maskPhone(phone:string):string{return '+62'+'*'.repeat(Math.max(1,phone.length-7))+phone.slice(-4);}
export class MockWhatsAppProvider implements NotificationProvider {
  readonly channel='MOCK_WHATSAPP';
  async send(delivery:NotificationDelivery):Promise<DeliveryResult>{
    if(!mockWhatsAppEnabled)return {status:'SKIPPED',code:'PROVIDER_DISABLED'};
    if(!delivery.consented||!delivery.phone)return {status:'SKIPPED',code:'NO_CONSENT'};
    if(!/^\+628[0-9]{7,11}$/.test(delivery.phone))return {status:'SKIPPED',code:'UNSUPPORTED_PHONE'};
    // Simulation only: no network call and no full recipient in logs or DTOs.
    return {status:'SENT',recipientMasked:maskPhone(delivery.phone)};
  }
}
export const inAppNotificationProvider=new InAppNotificationProvider();
export const mockWhatsAppProvider=new MockWhatsAppProvider();
