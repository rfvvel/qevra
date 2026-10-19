import type { z } from 'zod';
import type { healthResponseSchema, staffCredentialsSchema } from './schemas.js';

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type StaffCredentials = z.infer<typeof staffCredentialsSchema>;
export interface ApiErrorResponse { error: { code: string; message: string }; }
