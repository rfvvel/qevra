import type {CustomerNotification} from './notifications.js';
import { z } from 'zod';
import { slugSchema } from './configuration.js';
import type { QueueStatus } from './enums.js';
import type { QueueSessionStatus } from './queue.js';
export const phoneSchema=z.string().trim().max(40).transform(value=>{
  let phone=value.replace(/[\s().-]/g,'');
  if(!phone)return null;
  if(phone.startsWith('08'))phone='+62'+phone.slice(1);
  else if(phone.startsWith('62'))phone='+'+phone;
  return phone;
}).refine(value=>value===null || /^\+[1-9][0-9]{7,14}$/.test(value),'Use an international number such as +628123456789.');
export const customerJoinSchema=z.object({
  branchSlug:slugSchema,serviceId:z.uuid(),customerName:z.string().trim().min(1).max(120),phone:phoneSchema.optional(),whatsappOptIn:z.boolean().default(false),
}).strict().refine(data=>!data.whatsappOptIn||Boolean(data.phone&&/^\+628[0-9]{7,11}$/.test(data.phone)),{message:'WhatsApp consent requires an Indonesian mobile number.',path:['whatsappOptIn']});
export const customerCancelSchema=z.object({expectedVersion:z.number().int().positive()}).strict();
export const activeTicketQuerySchema=z.object({serviceId:z.uuid()}).strict();
export type CustomerJoinInput=z.input<typeof customerJoinSchema>;
export type CustomerJoinData=z.output<typeof customerJoinSchema>;
export type EtaStatus='AVAILABLE'|'PAUSED'|'UNAVAILABLE';
export interface EtaResult {peopleAhead:number;estimatedWaitMinutes:number|null;etaStatus:EtaStatus;calculatedAt:string;}
export interface CustomerTicketSnapshot {
  notifications:CustomerNotification[];mockWhatsAppAvailable:boolean;
  ticket:{id:string;queueNumber:string;status:QueueStatus;version:number;joinedAt:string};
  business:{name:string};branch:{name:string;publicSlug:string;address:string|null};service:{id:string;name:string};
  queue:EtaResult & {sessionStatus:QueueSessionStatus;nowServing:string[];revision:string;generatedAt:string;realtimeTopic:string};
}
export interface ActiveCustomerTicket {ticketId:string;serviceId:string;queueNumber:string;status:QueueStatus;}
