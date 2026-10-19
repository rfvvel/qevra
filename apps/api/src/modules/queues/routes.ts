import {Router,type Request} from 'express';
import {uuidSchema,idempotencyKeySchema,queueOpenSchema,queueControlSchema,callNextSchema,ticketCommandSchema,ticketCallSchema,historyQuerySchema,queueQuerySchema,type TicketAction} from '@qevra/contracts';
import {requireAuth,requireStaff} from '../../middleware/authentication.js';
import {withTransaction} from '../../db/transaction.js';
import type {TransactionRunner} from '../configuration/routes.js';
import {authorizeQueue,lockQueueContext,type QueueIds} from './context.js';
import {idempotentCommand} from './idempotency.js';
import {control,callNext,transition} from './engine.js';
import {snapshot,history} from './queries.js';
const base='/:businessId/branches/:branchId/services/:serviceId';
function ids(req:Request):QueueIds{return {businessId:uuidSchema.parse(req.params.businessId),branchId:uuidSchema.parse(req.params.branchId),serviceId:uuidSchema.parse(req.params.serviceId)};}
export function createQueueRouter(run:TransactionRunner=withTransaction):Router{
  const router=Router();
  router.use([base+'/queue',base+'/tickets',base+'/history'],requireAuth,requireStaff);
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get(base+'/queue',async(req,res)=>{
    queueQuerySchema.parse(req.query);
    res.json(await run(async client=>{const scope=ids(req);await authorizeQueue(client,scope,req.actor!.userId);return snapshot(client,await lockQueueContext(client,scope,false));}));
  });
  router.get(base+'/history',async(req,res)=>{
    const query=historyQuerySchema.parse(req.query);
    res.json(await run(async client=>{const scope=ids(req);await authorizeQueue(client,scope,req.actor!.userId);return history(client,await lockQueueContext(client,scope,false),query);}));
  });
  for(const action of ['open','pause','resume','close','call-next']){
    router.post(base+'/queue/'+action,async(req,res)=>{
      const data=action==='open'?queueOpenSchema.parse(req.body):action==='call-next'?callNextSchema.parse(req.body):queueControlSchema.parse(req.body);
      const key=idempotencyKeySchema.parse(req.get('Idempotency-Key'));
      res.json(await run(async client=>{
        const scope=ids(req),actor={userId:req.actor!.userId,type:'STAFF' as const};
        await authorizeQueue(client,scope,actor.userId);
        return idempotentCommand(client,scope,actor.userId,key,action,data,async()=>{
          const context=await lockQueueContext(client,scope);
          return action==='call-next'?callNext(client,context,actor,callNextSchema.parse(data)):control(client,context,actor,action,data);
        });
      }));
    });
  }
  for(const action of ['call','start','complete','skip','no-show','requeue','cancel'] as TicketAction[]){
    router.post(base+'/tickets/:ticketId/'+action,async(req,res)=>{
      const data=action==='call'?ticketCallSchema.parse(req.body):ticketCommandSchema.parse(req.body);
      const ticketId=uuidSchema.parse(req.params.ticketId),key=idempotencyKeySchema.parse(req.get('Idempotency-Key'));
      res.json(await run(async client=>{
        const scope=ids(req),actor={userId:req.actor!.userId,type:'STAFF' as const};
        await authorizeQueue(client,scope,actor.userId);
        return idempotentCommand(client,scope,actor.userId,key,'ticket/'+ticketId+'/'+action,data,async()=>transition(client,await lockQueueContext(client,scope),actor,ticketId,action,data));
      }));
    });
  }
  return router;
}
