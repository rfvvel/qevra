import assert from 'node:assert/strict';
import {test} from 'node:test';
import {whatsappConfiguration} from '../apps/api/src/config/whatsapp.js';
import {verifyInbound,InboundVerificationError,windowOpen,type InboundVerificationCode} from '../apps/api/src/modules/notifications/twilio-provider.js';
import type {MetaTransport} from '../apps/api/src/modules/notifications/meta-provider.js';

const config=whatsappConfiguration({NODE_ENV:'test',WHATSAPP_PROVIDER:'TWILIO',
  TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'offline-token',
  TWILIO_WHATSAPP_FROM:'whatsapp:+15005550006',TWILIO_WEBHOOK_ORIGIN:'https://example.test'});
const sid='SM'+'b'.repeat(32),phone='+6281234567890';
const resource={sid,account_sid:config.TWILIO_ACCOUNT_SID,direction:'inbound',
  from:'whatsapp:'+phone,to:config.TWILIO_WHATSAPP_FROM,
  date_created:'Fri, 24 May 2019 17:44:46 +0000',date_sent:null,
  status:'receiving',body:'private message',error_code:null,num_media:'0'};
async function rejected(transport:MetaTransport,code:InboundVerificationCode){
  await assert.rejects(verifyInbound(config,sid,phone,transport),error=>{
    assert.ok(error instanceof InboundVerificationError);
    assert.equal(error.code,code);
    assert.ok(!error.message.includes('private'));
    return true;
  });
}
test('inbound REST lookup uses GET, account-scoped Basic Auth and original timestamp for receiving/received messages',async()=>{
  for(const status of ['receiving','received']){
    const at=await verifyInbound(config,sid,phone,async(url,init)=>{
      assert.equal(url,`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages/${sid}.json`);
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.ok(init.signal);
      assert.equal(new Headers(init.headers).get('Authorization'),'Basic '+Buffer.from(config.TWILIO_ACCOUNT_SID+':offline-token').toString('base64'));
      assert.equal(init.body,undefined);
      return Response.json({...resource,status});
    });
    assert.equal(at.toISOString(),'2019-05-24T17:44:46.000Z');
    assert.equal(windowOpen(at),false);
  }
});
test('HTTP failures remain distinct without reading sensitive provider bodies',async()=>{
  for(const [status,code] of [[401,'HTTP_401'],[403,'HTTP_403'],[404,'HTTP_404'],[429,'HTTP_429'],[500,'HTTP_5XX'],[503,'HTTP_5XX'],[400,'HTTP_OTHER']] as const){
    const response=Response.json({message:'private credential/account/url',code:20003},{status});
    response.json=async()=>{assert.fail('Error body must not be read');};
    await rejected(async()=>response,code);
  }
});
test('provider identity and timestamp failures each have safe codes',async()=>{
  for(const [patch,code] of [
    [{sid:'SM'+'c'.repeat(32)},'SID_MISMATCH'],
    [{account_sid:'AC'+'c'.repeat(32)},'ACCOUNT_MISMATCH'],
    [{direction:'outbound-api'},'DIRECTION_MISMATCH'],
    [{from:'whatsapp:+628999999999'},'SENDER_MISMATCH'],
    [{to:'whatsapp:+15005550007'},'RECIPIENT_MISMATCH'],
    [{date_created:null},'TIMESTAMP_INVALID'],[{date_created:0},'TIMESTAMP_INVALID'],
    [{date_created:''},'TIMESTAMP_INVALID'],[{date_created:'invalid'},'TIMESTAMP_INVALID'],
    [{date_created:new Date(Date.now()+3600000).toUTCString()},'TIMESTAMP_FUTURE'],
  ] as const)await rejected(async()=>Response.json({...resource,...patch}),code);
  await rejected(async()=>new Response('not JSON'), 'RESPONSE_JSON');
  for(const value of [null,[], 'private'])await rejected(async()=>Response.json(value),'RESPONSE_SHAPE');
});
test('network, timeout, DNS and TLS failures never expose error details',async()=>{
  for(const [error,code] of [
    [new DOMException('private','TimeoutError'),'TRANSPORT_TIMEOUT'],
    [new TypeError('private',{cause:{code:'ENOTFOUND'}}),'TRANSPORT_DNS'],
    [new TypeError('private',{cause:{code:'CERT_HAS_EXPIRED'}}),'TRANSPORT_TLS'],
    [new TypeError('private',{cause:{code:'ECONNRESET'}}),'TRANSPORT_NETWORK'],
    [new TypeError('private',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}}),'TRANSPORT_TIMEOUT'],
  ] as const)await rejected(async()=>{throw error;},code);
  const response=Response.json(resource);
  response.json=async()=>{throw new DOMException('private','TimeoutError');};
  await rejected(async()=>response,'TRANSPORT_TIMEOUT');
});
