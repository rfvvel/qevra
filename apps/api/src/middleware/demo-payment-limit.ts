import type {RequestHandler} from 'express';

// Per authenticated customer, not forwarded IP. No recipient or participant cap.
// Process-local defense only: replicas/restarts and new anonymous identities reset it.
export function demoPaymentLimit(now=Date.now):RequestHandler{
  const buckets=new Map<string,{count:number;until:number}>();
  return (req,res,next)=>{
    if(req.method!=='POST'||!req.actor){next();return;}
    const time=now();
    for(const [id,bucket] of buckets)if(bucket.until<=time)buckets.delete(id);
    const id=req.actor.userId;
    let bucket=buckets.get(id);
    if(!bucket){
      // Bound memory without denying new participants.
      if(buckets.size>=10000)buckets.delete(buckets.keys().next().value!);
      bucket={count:0,until:time+60000};buckets.set(id,bucket);
    }
    if(++bucket.count>30){
      res.set('Retry-After',String(Math.ceil((bucket.until-time)/1000)));
      res.status(429).json({error:{code:'DEMO_RATE_LIMIT',message:'Please wait before trying again.'}});return;
    }
    next();
  };
}
