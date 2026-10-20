import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {createHmac} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {PoolClient} from 'pg';

test('real Express stack accepts signed Twilio forms and safely diagnoses each failure stage',async()=>{
  const origin='https://api.example.test',account='AC'+'1'.repeat(32),token='offline-test-token';
  const sender='whatsapp:+15005550006',phone='whatsapp:+6281234567890',sid='SM'+'2'.repeat(32);
  Object.assign(process.env,{NODE_ENV:'production',WHATSAPP_PROVIDER:'TWILIO',TWILIO_HOSTED_DEMO_ENABLED:'true',
    TWILIO_ACCOUNT_SID:account,TWILIO_AUTH_TOKEN:token,TWILIO_WHATSAPP_FROM:sender,TWILIO_WEBHOOK_ORIGIN:origin,
    SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'offline',WEB_ORIGIN:'https://web.example.test'});
  const {createApp}=await import('../apps/api/src/app.js');
  let databaseFailure=false,providerFailure=false,lookups=0;
  const writes:unknown[][]=[],logs:string[]=[];
  const at=new Date(Date.now()-25*3600000).toUTCString();
  const client={query:async(_sql:string,params:unknown[])=>{
    if(databaseFailure)throw Object.assign(new Error('sensitive database detail'),{code:'23514'});
    writes.push(params);return {rows:[]};
  }} as unknown as PoolClient;
  const logger=mock.method(console,'error',(line:string)=>{logs.push(line);});
  const originalFetch=globalThis.fetch;
  const transport=mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const url=String(input);
    if(url.startsWith('http://127.0.0.1:'))return originalFetch(input,init);
    assert.equal(url,`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages/${sid}.json`);
    lookups++;
    if(providerFailure)throw new Error('sensitive provider detail');
    return Response.json({sid,account_sid:account,direction:'inbound',from:phone,to:sender,date_created:at});
  });
  const server=createApp({runTransaction:async op=>op(client)}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const path='/api/v1/webhooks/twilio/inbound';
  const body={AccountSid:account,MessageSid:sid,SmsSid:sid,SmsMessageSid:sid,From:phone,To:sender,
    Body:'PRIVATE pesan + & = café 👋',ProfileName:'PRIVATE customer',WaId:'6281234567890',
    SmsStatus:'received',NumMedia:'0',NumSegments:'1',ApiVersion:'2010-04-01',
    MessageType:'text',ReferralNumMedia:'0',FutureField:'included in signature'};
  const sign=(p:string,b:Record<string,string>,o=origin)=>createHmac('sha1',token)
    .update(o+p+Object.keys(b).sort().map(k=>k+b[k]).join('')).digest('base64');
  const post=(b=body,p=path,signature=sign(p,b),raw=new URLSearchParams(b).toString(),
    contentType='application/x-www-form-urlencoded; charset=UTF-8')=>fetch(base+p,{
      method:'POST',headers:{'Content-Type':contentType,'X-Twilio-Signature':signature,
        'X-Forwarded-Proto':'http','X-Forwarded-Host':'untrusted.example.test'},body:raw});
  const failure=async(response:Response,status:number,code:string)=>{
    assert.equal(response.status,status);
    assert.equal(response.headers.get('x-qevra-webhook'),'twilio-v1');
    assert.deepEqual(await response.json(),{error:{code:'TWILIO_'+code}});
    assert.equal(JSON.parse(logs.at(-1)!).code,code);
  };
  try{
    for(let i=0;i<2;i++){
      const response=await post();
      assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/xml/);
      assert.equal(await response.text(),'<Response/>');
    }
    assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);
    assert.equal((writes[0]![4] as Date).toUTCString(),at); // Replay does not renew 24h window.
    assert.ok(!JSON.stringify(writes).includes('PRIVATE'));
    const before=lookups;
    for(const [patch,code] of [
      [{To:'whatsapp:+15005550007'},'DESTINATION'],
      [{From:'whatsapp:+12025550100'},'SENDER'],
      [{From:phone.replace('whatsapp:','')},'SENDER'],
      [{MessageSid:''},'MESSAGE_SID'],
      [{MessageSid:'MM'+'2'.repeat(32)},'MESSAGE_SID'],
    ] as const)await failure(await post({...body,...patch}),400,code);
    await failure(await post(body,path+'/',sign(path+'/',body)),400,'INBOUND_URL');
    await failure(await post(body,path+'?extra=1'),400,'INBOUND_URL');
    await failure(await post({...body,AccountSid:'AC'+'3'.repeat(32)}),403,'ACCOUNT');
    await failure(await post({...body,Body:'tampered'},path,sign(path,body)),403,'SIGNATURE');
    await failure(await post(body,path,sign(path,body,'http://api.example.test')),403,'SIGNATURE');
    await failure(await post(body,path,''),403,'SIGNATURE');
    await failure(await post(body,path,sign(path,body),new URLSearchParams(body)+'&From=duplicate'),400,'FORM_FIELDS');
    await failure(await post(body,path,sign(path,body),'{}','application/json'),415,'CONTENT_TYPE');
    await failure(await post(body,path,sign(path,body),'Body=x','application/x-www-form-urlencoded; charset=koi8-r'),415,'BODY_ENCODING');
    await failure(await post(body,path,sign(path,body),'Body='+'x'.repeat(33000)),413,'BODY_LIMIT');
    await failure(await post(body,path,sign(path,body),Array.from({length:101},(_,i)=>'f'+i+'=x').join('&')),413,'BODY_LIMIT');
    await failure(await fetch(base+path,{method:'POST',headers:{
      'Content-Type':'application/x-www-form-urlencoded','Content-Encoding':'gzip',
    },body:'not a gzip stream'}),400,'BODY_PARSE');
    await failure(await fetch(base+path),405,'METHOD');
    assert.equal(lookups,before);assert.equal(writes.length,2);
    providerFailure=true;
    await failure(await post(),502,'INBOUND_VERIFICATION');
    assert.equal(JSON.parse(logs.at(-1)!).reason,'TRANSPORT_NETWORK');
    assert.equal(writes.length,2);
    providerFailure=false;databaseFailure=true;
    await failure(await post(),503,'DATABASE');
    assert.deepEqual(JSON.parse(logs.at(-1)!).database,{category:'postgresql',code:'23514'});
    for(const secret of [token,phone,sender,body.Body,body.ProfileName,body.WaId,sign(path,body),'sensitive'])
      assert.ok(!logs.join('').includes(secret));
  }finally{
    transport.mock.restore();logger.mock.restore();server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
