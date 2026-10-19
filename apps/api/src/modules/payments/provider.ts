import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {MockPaymentOutcome} from '@qevra/contracts';
import {HttpError} from '../../shared/http-error.js';
export interface PaymentIntent {id:string;amount:string;currency:'IDR';expiresAt:Date;}
export interface VerifiedPaymentEvent {provider:string;reference:string;eventId:string;outcome:MockPaymentOutcome;amount:string;currency:'IDR';}
export interface PaymentProvider {
  readonly name:string;
  createCheckout(intent:PaymentIntent):Promise<{reference:string}>;
  verifyNotification(notification:unknown):Promise<VerifiedPaymentEvent>;
}
const notificationSchema=z.object({reference:z.string().min(1).max(160),eventId:z.string().min(1).max(200),outcome:z.enum(['SUCCESS','FAILURE','EXPIRY']),amount:z.string().regex(/^[1-9][0-9]*$/),currency:z.literal('IDR')}).strict();
// Server-only mock proof. No signature or provider secret is returned to React.
export class MockPaymentProvider implements PaymentProvider {
  readonly name='MOCK';
  private readonly secret=randomBytes(32);
  async createCheckout(intent:PaymentIntent){return {reference:'mock_'+intent.id};}
  private signature(data:unknown):string{return createHmac('sha256',this.secret).update(JSON.stringify(data)).digest('hex');}
  simulate(event:Omit<VerifiedPaymentEvent,'provider'>):unknown{
    const data=notificationSchema.parse(event);
    return {data,signature:this.signature(data)};
  }
  async verifyNotification(notification:unknown):Promise<VerifiedPaymentEvent>{
    const envelope=z.object({data:notificationSchema,signature:z.string().regex(/^[0-9a-f]{64}$/)}).strict().safeParse(notification);
    if(!envelope.success)throw new HttpError(400,'INVALID_PAYMENT_PROOF','Payment confirmation could not be verified.');
    const expected=Buffer.from(this.signature(envelope.data.data),'hex'),actual=Buffer.from(envelope.data.signature,'hex');
    if(!timingSafeEqual(expected,actual))throw new HttpError(400,'INVALID_PAYMENT_PROOF','Payment confirmation could not be verified.');
    return {provider:this.name,...envelope.data.data};
  }
}
export const mockPaymentProvider=new MockPaymentProvider();
