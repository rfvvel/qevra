import { normalizedEmailSchema } from './registration.js';
import { z } from 'zod';
import { BusinessRole, QueueStatus, PaymentMode, PaymentStatus } from './enums.js';

export const businessRoleSchema = z.enum(BusinessRole);
export const queueStatusSchema = z.enum(QueueStatus);
export const paymentModeSchema = z.enum(PaymentMode);
export const paymentStatusSchema = z.enum(PaymentStatus);
export const uuidSchema = z.uuid();
export const staffCredentialsSchema = z.object({ email: normalizedEmailSchema, password: z.string().min(1) });
export const healthResponseSchema = z.object({ status: z.literal('ok'), service: z.literal('qevra-api') });
