import assert from 'node:assert/strict';
import {test} from 'node:test';
import {customerJoinSchema,phoneSchema} from '@qevra/contracts';
import {CounterEtaCalculator,type EtaInput} from '../apps/api/src/modules/customer/eta.js';
const now=new Date('2026-09-20T10:00:00Z');
function estimate(overrides:Partial<EtaInput>={}){return new CounterEtaCalculator().calculate({now,peopleAhead:0,durationMinutes:30,sessionOpen:true,serviceActive:true,waiting:true,counters:[{status:null,servingAt:null}],...overrides});}
test('ETA distributes predecessors across available counters',()=>{
  assert.equal(estimate({peopleAhead:3}).estimatedWaitMinutes,90);
  assert.equal(estimate({peopleAhead:3,counters:[{status:null,servingAt:null},{status:null,servingAt:null}]}).estimatedWaitMinutes,30);
  assert.equal(estimate({peopleAhead:2,counters:[{status:null,servingAt:null},{status:null,servingAt:null}]}).estimatedWaitMinutes,30);
});
test('ETA accounts for called occupancy, remaining service and overdue uncertainty',()=>{
  assert.equal(estimate({counters:[{status:'CALLED',servingAt:null}]}).estimatedWaitMinutes,30);
  assert.equal(estimate({counters:[{status:'SERVING',servingAt:new Date('2026-09-20T09:40:00Z')}]}).estimatedWaitMinutes,10);
  assert.equal(estimate({counters:[{status:'SERVING',servingAt:new Date('2026-09-20T08:00:00Z')}]}).estimatedWaitMinutes,1);
  assert.equal(estimate({counters:[{status:'SERVING',servingAt:new Date('2026-09-20T11:00:00Z')}]}).estimatedWaitMinutes,30);
});
test('ETA never invents a number without operating capacity or for terminal tickets',()=>{
  for(const input of [{counters:[]},{sessionOpen:false},{serviceActive:false}]){assert.equal(estimate(input).estimatedWaitMinutes,null);assert.equal(estimate(input).etaStatus,'PAUSED');}
  assert.equal(estimate({waiting:false}).etaStatus,'UNAVAILABLE');
});
test('customer phone normalization is optional and rejects unsafe input',()=>{
  assert.equal(phoneSchema.parse('0812 3456 7890'),'+6281234567890');
  assert.equal(phoneSchema.parse('+1 (202) 555-0147'),'+12025550147');
  assert.equal(phoneSchema.parse(''),null);
  assert.equal(phoneSchema.safeParse('call me 0812').success,false);
  assert.equal(phoneSchema.safeParse('123').success,false);
  const body={branchSlug:'demo',serviceId:'00000000-0000-4000-8000-000000000001',customerName:' Customer '};
  assert.equal(customerJoinSchema.parse(body).customerName,'Customer');
  for(const extra of [{payment_mode:'NONE'},{price:0},{customer_auth_id:'spoof'},{queue_prefix:'X'}])assert.equal(customerJoinSchema.safeParse({...body,...extra}).success,false);
});
