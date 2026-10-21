import { z } from 'zod';
import { QueueStatus } from './enums.js';
export enum QueueSessionStatus { OPEN = 'OPEN', PAUSED = 'PAUSED', CLOSED = 'CLOSED' }
export const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19);
export const idempotencyKeySchema = z.uuid();
export const queueOpenSchema = z.object({}).strict();
export const queueControlSchema = z.object({ sessionId: z.uuid(), expectedRevision: revisionSchema }).strict();
export const callNextSchema = z.object({ counterId: z.uuid(), sessionId: z.uuid().optional() }).strict();
export const ticketCommandSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const ticketCallSchema = ticketCommandSchema.extend({ counterId: z.uuid(), reason: z.string().trim().min(1).max(300).optional() }).strict();
export const queueQuerySchema = z.object({}).strict();
export const historyQuerySchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type TicketAction = 'call' | 'start' | 'complete' | 'skip' | 'no-show' | 'requeue' | 'cancel';
export interface QueueSessionDto { id: string; businessDate: string; status: QueueSessionStatus; revision: string; }
export interface QueueTicketDto {
  simulatedPayment:boolean;
  id: string; sessionId: string; businessDate: string; number: string; sequenceNumber: number; queueOrder: string;
  status: QueueStatus; counterId: string | null; version: number; customerName: string;
  joinedAt: string; calledAt: string | null; servingAt: string | null; completedAt: string | null;
  skippedAt: string | null; cancelledAt: string | null; noShowAt: string | null;
}
export interface QueueCounterDto { id: string; name: string; isActive: boolean; activeTicketId: string | null; }
export interface QueueSnapshot {
  session: QueueSessionDto | null; businessDate: string; timezone: string; serviceName: string; branchName: string;
  acceptingOperations: boolean; revision: string; generatedAt: string;
  waiting: QueueTicketDto[]; called: QueueTicketDto[]; serving: QueueTicketDto[]; skipped: QueueTicketDto[]; carryover: QueueTicketDto[];
  counters: QueueCounterDto[];
  summary: { waitingCount: number; calledCount: number; servingCount: number; completedToday: number };
}
export interface QueueCommandResult { outcome: 'APPLIED' | 'EMPTY' | 'UNCHANGED'; sessionId: string; ticketId: string | null; revision: string; }
export interface QueueHistoryEvent {
  id: string; eventType: string; sessionId: string; ticketId: string | null; number: string | null;
  fromStatus: string | null; toStatus: string | null; actorType: string; occurredAt: string; metadata: Record<string, unknown>;
}
export interface QueueHistory { events: QueueHistoryEvent[]; page: number; hasMore: boolean; generatedAt: string; }
export function formatQueueNumber(prefix: string, sequence: number): string { return prefix + String(sequence).padStart(3, '0'); }
export const ticketTransitions: Record<TicketAction, { from: QueueStatus[]; to: QueueStatus }> = {
  call: { from: [QueueStatus.WAITING], to: QueueStatus.CALLED },
  start: { from: [QueueStatus.CALLED], to: QueueStatus.SERVING },
  complete: { from: [QueueStatus.SERVING], to: QueueStatus.COMPLETED },
  skip: { from: [QueueStatus.CALLED], to: QueueStatus.SKIPPED },
  'no-show': { from: [QueueStatus.CALLED], to: QueueStatus.NO_SHOW },
  requeue: { from: [QueueStatus.SKIPPED], to: QueueStatus.WAITING },
  cancel: { from: [QueueStatus.WAITING, QueueStatus.CALLED], to: QueueStatus.CANCELLED },
};
