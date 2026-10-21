import 'dotenv/config';
import { z } from 'zod';
import {whatsappConfiguration} from './whatsapp.js';
import {mockPaymentEnabled} from './payments.js';

const optionalValue = z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional());
const envSchema = z.object({
  MOCK_WHATSAPP_ENABLED: z.enum(['true','false']).default('false'),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PAYMENT_PROVIDER: z.enum(['DISABLED','MOCK']).default('DISABLED'),
  PAYMENT_HOSTED_DEMO_ENABLED: z.enum(['true','false']).default('false'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  SUPABASE_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  SUPABASE_PUBLISHABLE_KEY: optionalValue,
  DATABASE_URL: optionalValue,
  DATABASE_CA_CERT: optionalValue,
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) throw new Error(`Invalid environment variables: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
export const env = parsed.data;

export const mockPaymentsEnabled = mockPaymentEnabled(env);

export const whatsapp=whatsappConfiguration(process.env);
export const mockWhatsAppEnabled = whatsapp.mode === 'MOCK';
