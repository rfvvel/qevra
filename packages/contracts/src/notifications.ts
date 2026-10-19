import {z} from 'zod';
export const notificationTypes=['QUEUE_JOINED','NEAR_TURN','YOUR_TURN','SERVICE_STARTED','SERVICE_COMPLETED','QUEUE_CANCELLED','QUEUE_SKIPPED','QUEUE_NO_SHOW'] as const;
export type NotificationType=typeof notificationTypes[number];
export type NotificationStatus='PENDING'|'SENT'|'FAILED'|'SKIPPED';
export interface CustomerNotification {id:string;type:NotificationType;title:string;message:string;createdAt:string;readAt:string|null;}
export interface MockWhatsAppNotification extends CustomerNotification {status:NotificationStatus;recipientMasked:string|null;failureCode:string|null;}
export const notificationReadSchema=z.object({}).strict();
