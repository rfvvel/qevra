import {Router} from 'express';
import {analyticsQuerySchema,uuidSchema} from '@qevra/contracts';
import {requireAuth,requireStaff} from '../../middleware/authentication.js';
import {withTransaction} from '../../db/transaction.js';
import type {TransactionRunner} from '../configuration/routes.js';
import {dashboard} from './service.js';
export function createAnalyticsRouter(run:TransactionRunner=withTransaction):Router {
  const router=Router();
  router.get('/:businessId/analytics',requireAuth,requireStaff,async(req,res)=>{
    res.set('Cache-Control','no-store');
    const businessId=uuidSchema.parse(req.params.businessId),query=analyticsQuerySchema.parse(req.query);
    res.json(await run(client=>dashboard(client,businessId,req.actor!.userId,query)));
  });
  return router;
}
