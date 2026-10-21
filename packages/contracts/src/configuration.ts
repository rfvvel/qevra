import { z } from 'zod';
import { BusinessRole, PaymentMode } from './enums.js';

export const nameSchema = z.string().trim().min(1).max(160);
export const slugSchema = z.string().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.');
export const moneySchema = z.string().regex(/^(0|[1-9][0-9]*)$/, 'Enter a whole rupiah amount.').refine(value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n, 'Amount exceeds the supported limit.');
export const timezoneSchema = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Use a valid IANA timezone, for example Asia/Jakarta.');
export const businessStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
const nonEmpty = (value: object) => Object.keys(value).length > 0;
export const businessCreateSchema = z.object({ name: nameSchema, slug: slugSchema, status: businessStatusSchema.default('ACTIVE') }).strict();
export const businessPatchSchema = z.object({ name: nameSchema.optional(), slug: slugSchema.optional(), status: businessStatusSchema.optional() }).strict().refine(nonEmpty, 'Provide at least one change.');
export const branchCreateSchema = z.object({
  name: nameSchema, public_slug: slugSchema, timezone: timezoneSchema.default('Asia/Jakarta'),
  address: z.string().trim().max(1000).nullable().default(null), is_active: z.boolean().default(true),
}).strict();
export const branchPatchSchema = z.object({ name: nameSchema.optional(), public_slug: slugSchema.optional(), timezone: timezoneSchema.optional(), address: z.string().trim().max(1000).nullable().optional(), is_active: z.boolean().optional() }).strict().refine(nonEmpty, 'Provide at least one change.');
const serviceFields = z.object({
  name: nameSchema, description: z.string().trim().max(3000).nullable().default(null),
  price_amount: moneySchema, currency: z.literal('IDR').default('IDR'),
  estimated_duration_minutes: z.number().int().min(1).max(1440),
  queue_prefix: z.string().regex(/^[A-Z]{1,5}$/, 'Use 1–5 uppercase letters.'),
  payment_mode: z.enum(PaymentMode).default(PaymentMode.NONE),
  deposit_amount: moneySchema.nullable().default(null), is_active: z.boolean().default(true),
}).strict();
function validPayment(value: z.infer<typeof serviceFields>): boolean {
  if (!/^[0-9]+$/.test(value.price_amount) || (value.deposit_amount !== null && !/^[0-9]+$/.test(value.deposit_amount))) return false;
  if (value.payment_mode === PaymentMode.NONE) return value.deposit_amount === null;
  if (value.payment_mode === PaymentMode.FULL) return value.deposit_amount === null && BigInt(value.price_amount) > 0n;
  return value.deposit_amount !== null && BigInt(value.deposit_amount) > 0n && BigInt(value.deposit_amount) <= BigInt(value.price_amount);
}
export const serviceCreateSchema = serviceFields.refine(validPayment, { message: 'NONE/FULL require no deposit; FULL requires a positive price; DEPOSIT must be positive and no larger than the price.', path: ['deposit_amount'] });
// The server merges PATCH with the stored record, then validates the complete configuration.
export const servicePatchSchema = z.object({
  name: nameSchema.optional(), description: z.string().trim().max(3000).nullable().optional(), price_amount: moneySchema.optional(),
  currency: z.literal('IDR').optional(), estimated_duration_minutes: z.number().int().min(1).max(1440).optional(),
  queue_prefix: z.string().regex(/^[A-Z]{1,5}$/).optional(), payment_mode: z.enum(PaymentMode).optional(),
  deposit_amount: moneySchema.nullable().optional(), is_active: z.boolean().optional(),
}).strict().refine(nonEmpty, 'Provide at least one change.');
export const counterCreateSchema = z.object({ name: nameSchema.max(120), is_active: z.boolean().default(true) }).strict();
export const counterPatchSchema = z.object({ name: nameSchema.max(120).optional(), is_active: z.boolean().optional() }).strict().refine(nonEmpty, 'Provide at least one change.');
export const memberCreateSchema = z.object({ user_id: z.uuid(), role: z.enum(BusinessRole) }).strict();
export const memberPatchSchema = z.object({ role: z.enum(BusinessRole).optional(), is_active: z.boolean().optional() }).strict().refine(nonEmpty, 'Provide at least one change.');
export const assignmentsSchema = z.object({
  branch_ids: z.array(z.uuid()).max(200),
  service_ids: z.array(z.uuid()).max(1000),
}).strict().refine(value => new Set(value.branch_ids).size === value.branch_ids.length && new Set(value.service_ids).size === value.service_ids.length, 'Assignments must not contain duplicates.');

export type BusinessCreate = z.infer<typeof businessCreateSchema>;
export type BranchCreate = z.infer<typeof branchCreateSchema>;
export type ServiceCreate = z.infer<typeof serviceCreateSchema>;
export type CounterCreate = z.infer<typeof counterCreateSchema>;
export interface BusinessDto { id: string; name: string; slug: string; status: 'ACTIVE' | 'INACTIVE'; role: BusinessRole; }
export interface BranchDto extends BranchCreate { id: string; business_id: string; }
export interface ServiceDto extends ServiceCreate { id: string; business_id: string; branch_id: string; }
export interface CounterDto extends CounterCreate { id: string; business_id: string; branch_id: string; service_id: string; }
export interface MemberDto { id: string; user_id: string; display_name: string; normalized_email: string | null; role: BusinessRole; is_active: boolean; branch_ids: string[]; service_ids: string[]; }
export interface PublicBranchDto { business_name: string; branch: Pick<BranchDto, 'name' | 'public_slug' | 'address' | 'timezone'>; services: (Pick<ServiceDto, 'id' | 'name' | 'description' | 'price_amount' | 'currency' | 'estimated_duration_minutes' | 'payment_mode' | 'deposit_amount'> & { online_payment_available:boolean; payment_simulated:boolean; queue_status: 'OPEN' | 'PAUSED' | 'CLOSED' | 'NOT_OPENED' })[]; }
