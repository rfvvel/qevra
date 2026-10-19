import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MockPaymentProvider} from '../apps/api/src/modules/payments/provider.js';
test('mock provider verifies server proof and rejects tampering',async()=>{
  const provider=new MockPaymentProvider();
  const event={reference:'mock_test',eventId:'event-1',outcome:'SUCCESS' as const,amount:'50000',currency:'IDR' as const};
  const notification=provider.simulate(event);
  const verified=await provider.verifyNotification(notification);
  assert.equal(verified.amount,'50000');assert.equal(verified.provider,'MOCK');
  await assert.rejects(provider.verifyNotification({...notification as object,signature:'0'.repeat(64)}),{status:400});
  await assert.rejects(provider.verifyNotification({paid:true,amount:1}),{status:400});
});
