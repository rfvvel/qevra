import {mockMessages,markNotificationRead} from '../notifications/service.js';
import {mockWhatsAppEnabled,env} from '../../config/env.js';
import {demoPaymentLimit} from '../../middleware/demo-payment-limit.js';
import { paymentService } from '../payments/service.js';
import { missing } from '../configuration/access.js';
import {Router} from 'express';
import {uuidSchema,idempotencyKeySchema,customerJoinSchema,customerCancelSchema,activeTicketQuerySchema,mockPaymentSchema,retryPaymentSchema,notificationReadSchema} from '@qevra/contracts';
import {requireAuth} from '../../middleware/authentication.js';
import {HttpError} from '../../shared/http-error.js';
import {withTransaction} from '../../db/transaction.js';
import type {TransactionRunner} from '../configuration/routes.js';
import {join,cancel,ticketSnapshot,activeTicket} from './service.js';
export function createCustomerRouter(run:TransactionRunner=withTransaction,mockEnabled=false):Router{
  const router=Router();
  router.post(['/payments/:paymentId/mock','/join-requests/:joinRequestId/payments'],(_req,_res,next)=>{if(!mockEnabled)throw missing();next();});
  router.get('/tickets/:ticketId/mock-whatsapp',(_req,_res,next)=>{if(!mockWhatsAppEnabled)throw missing();next();});
  router.use(requireAuth);
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!req.actor?.isAnonymous)throw new HttpError(403,'CUSTOMER_REQUIRED','Please return to the service page to continue.');
    next();
  });
  if(mockEnabled&&env.NODE_ENV==='production')router.use(['/join-requests','/payments'],demoPaymentLimit());
  router.post('/join-requests',async(req,res)=>{
    const body=customerJoinSchema.parse(req.body),key=idempotencyKeySchema.parse(req.get('Idempotency-Key'));
    res.json(await run(c=>join(c,req.actor!.userId,key,body,mockEnabled)));
  });
  router.get('/join-requests/:joinRequestId',async(req,res)=>{
    const id=uuidSchema.parse(req.params.joinRequestId);
    res.json(await run(c=>paymentService.checkout(c,req.actor!.userId,id,mockEnabled)));
  });
  router.post('/join-requests/:joinRequestId/payments',async(req,res)=>{
    const id=uuidSchema.parse(req.params.joinRequestId),key=idempotencyKeySchema.parse(req.get('Idempotency-Key'));retryPaymentSchema.parse(req.body);
    res.json(await run(c=>paymentService.retry(c,req.actor!.userId,id,key,mockEnabled)));
  });
  router.post('/payments/:paymentId/mock',async(req,res)=>{
    const id=uuidSchema.parse(req.params.paymentId),key=idempotencyKeySchema.parse(req.get('Idempotency-Key')),body=mockPaymentSchema.parse(req.body);
    res.json(await run(c=>paymentService.mockConfirm(c,req.actor!.userId,id,key,body.outcome,mockEnabled)));
  });
  router.get('/tickets/:ticketId/mock-whatsapp',async(req,res)=>{
    const id=uuidSchema.parse(req.params.ticketId);res.json(await run(c=>mockMessages(c,req.actor!.userId,id)));
  });
  router.post('/notifications/:notificationId/read',async(req,res)=>{
    const id=uuidSchema.parse(req.params.notificationId);notificationReadSchema.parse(req.body);
    res.json(await run(c=>markNotificationRead(c,req.actor!.userId,id)));
  });
  router.get('/active-ticket',async(req,res)=>{
    const {serviceId}=activeTicketQuerySchema.parse(req.query);
    res.json(await run(c=>activeTicket(c,req.actor!.userId,serviceId)));
  });
  router.get('/tickets/:ticketId',async(req,res)=>{
    const ticketId=uuidSchema.parse(req.params.ticketId);
    res.json(await run(c=>ticketSnapshot(c,req.actor!.userId,ticketId)));
  });
  router.post('/tickets/:ticketId/cancel',async(req,res)=>{
    const ticketId=uuidSchema.parse(req.params.ticketId),body=customerCancelSchema.parse(req.body),key=idempotencyKeySchema.parse(req.get('Idempotency-Key'));
    res.json(await run(c=>cancel(c,req.actor!.userId,ticketId,key,body.expectedVersion)));
  });
  return router;
}
