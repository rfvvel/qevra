import assert from 'node:assert/strict';
import {test} from 'node:test';
import {customerJoinSchema,phoneSchema} from '@qevra/contracts';
test('Indonesian phone normalization and explicit WhatsApp consent',()=>{
  for(const phone of ['081234567890','6281234567890','+6281234567890','0812 3456 7890'])assert.equal(phoneSchema.parse(phone),'+6281234567890');
  const base={branchSlug:'demo',serviceId:'00000000-0000-4000-8000-000000000001',customerName:'Customer'};
  assert.equal(customerJoinSchema.parse(base).whatsappOptIn,false);
  assert.equal(customerJoinSchema.parse({...base,phone:'081234567890'}).whatsappOptIn,false);
  assert.equal(customerJoinSchema.parse({...base,phone:'081234567890',whatsappOptIn:true}).whatsappOptIn,true);
  for(const phone of [undefined,'','abc','+12025550123'])assert.equal(customerJoinSchema.safeParse({...base,phone,whatsappOptIn:true}).success,false);
});
test('local providers mask phones, require consent and send no external requests',async()=>{
  process.env.NODE_ENV='test';process.env.MOCK_WHATSAPP_ENABLED='true';
  const {InAppNotificationProvider,MockWhatsAppProvider}=await import('../apps/api/src/modules/notifications/provider.js');
  const whatsapp=new MockWhatsAppProvider(),delivery={title:'Update',message:'Your turn',phone:'+6281234567890',consented:true,dedupeKey:'test'};
  assert.equal((await new InAppNotificationProvider().send()).status,'SENT');
  assert.deepEqual(await whatsapp.send(delivery),{status:'SENT',recipientMasked:'+62*******7890'});
  assert.equal((await whatsapp.send({...delivery,consented:false})).status,'SKIPPED');
  assert.equal((await whatsapp.send({...delivery,phone:null})).status,'SKIPPED');
});
