import {z} from 'zod';
import type {PaymentMode,PaymentStatus} from './enums.js';
import type {QueueCommandResult} from './queue.js';
export const mockPaymentSchema=z.object({outcome:z.enum(['SUCCESS','FAILURE','EXPIRY'])}).strict();
export const retryPaymentSchema=z.object({}).strict();
export type MockPaymentOutcome=z.infer<typeof mockPaymentSchema>['outcome'];
export type CustomerJoinResult=QueueCommandResult | {outcome:'PAYMENT_REQUIRED';joinRequestId:string;ticketId:null;sessionId:string;revision:string};
export interface PaymentAttemptDto {id:string;provider:string;status:PaymentStatus;amount:string;currency:'IDR';paidAt:string|null;expiresAt:string;createdAt:string;}
export interface CheckoutDto {
  joinRequest:{id:string;status:string;expiresAt:string};
  service:{name:string;branchName:string;branchSlug:string};
  pricing:{mode:PaymentMode;servicePrice:string;payNow:string;remaining:string;currency:'IDR'};
  payment:PaymentAttemptDto;attempts:PaymentAttemptDto[];ticketId:string|null;
  canRetry:boolean;mockControlsEnabled:boolean;generatedAt:string;
}
