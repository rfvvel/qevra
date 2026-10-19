import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
test('production disables mock payments and WhatsApp even when configured',async()=>{
  process.env.MOCK_WHATSAPP_ENABLED='true';process.env.NODE_ENV='production';process.env.PAYMENT_PROVIDER='MOCK';
  const {createApp}=await import('../apps/api/src/app.js');
  const server=createApp().listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1/customer';
  try{
    for(const path of ['/payments/00000000-0000-4000-8000-000000000001/mock','/join-requests/00000000-0000-4000-8000-000000000001/payments']){
      const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({outcome:'SUCCESS'})});
      assert.equal(response.status,404);
    }
    const inspection=await fetch(base+'/tickets/00000000-0000-4000-8000-000000000001/mock-whatsapp');assert.equal(inspection.status,404);
    const {MockWhatsAppProvider}=await import('../apps/api/src/modules/notifications/provider.js');
    assert.equal((await new MockWhatsAppProvider().send({title:'Update',message:'Test',phone:'+6281234567890',consented:true,dedupeKey:'production-test'})).status,'SKIPPED');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
