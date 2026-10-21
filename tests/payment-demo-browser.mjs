// Offline production-build smoke test. All Auth/API data is synthetic; no .env is loaded.
import {build,preview} from 'vite';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
await build({root:'apps/web',configFile:'apps/web/vite.config.ts',envDir:false,define:{
  'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://offline.example.test'),
  'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('offline-key'),
  'import.meta.env.VITE_API_URL':JSON.stringify('/api/v1'),
},build:{outDir:'../../.runtime/payment-demo-web'}});
const server=await preview({root:'apps/web',configFile:false,envDir:false,build:{outDir:'../../.runtime/payment-demo-web'},preview:{host:'127.0.0.1',port:5187,strictPort:true}});
let browser;
try{
  browser=await chromium.launch({channel:'chrome'});
  for(const mode of ['DEPOSIT','FULL','NONE']){
    const context=await browser.newContext();
    const user=randomUUID(),service=randomUUID(),join=randomUUID(),payment=randomUUID(),ticket=randomUUID();
    let confirmed=false,confirmCalls=0;
    const expires=Math.floor(Date.now()/1000)+3600;
    const access=[{alg:'HS256',typ:'JWT'},{sub:user,exp:expires,is_anonymous:true},'offline'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
    await context.addInitScript(({user,access,expires})=>localStorage.setItem('qevra-customer-offline.example.test',JSON.stringify({access_token:access,refresh_token:'offline',expires_at:expires,expires_in:3600,token_type:'bearer',user:{id:user,is_anonymous:true}})),{user,access,expires});
    await context.routeWebSocket('**/*',socket=>socket.close());
    const checkout=()=>({joinRequest:{id:join,status:confirmed?'ADMITTED':'PAYMENT_PENDING',expiresAt:new Date(Date.now()+1800000).toISOString()},
      service:{name:'Demo service',branchName:'Demo branch',branchSlug:'demo'},pricing:{mode,servicePrice:'100000',payNow:mode==='DEPOSIT'?'25000':'100000',remaining:mode==='DEPOSIT'?'75000':'0',currency:'IDR'},
      payment:{id:payment,provider:'MOCK',status:confirmed?'PAID':'PENDING'},attempts:[],ticketId:confirmed?ticket:null,canRetry:false,mockControlsEnabled:true,generatedAt:new Date().toISOString()});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='127.0.0.1'){await route.abort();return;}
      if(!url.pathname.startsWith('/api/')){await route.continue();return;}
      let data;
      if(url.pathname.includes('/public/branches/'))data={business_name:'Any business',branch:{name:'Demo branch',public_slug:'demo'},services:[{id:service,name:'Demo service',price_amount:'100000',payment_mode:mode,deposit_amount:'25000',online_payment_available:true,payment_simulated:mode!=='NONE',queue_status:'OPEN'}]};
      else if(url.pathname.endsWith('/active-ticket'))data=null;
      else if(url.pathname.endsWith('/join-requests'))data=mode==='NONE'?{outcome:'APPLIED',ticketId:ticket}:{outcome:'PAYMENT_REQUIRED',joinRequestId:join,ticketId:null};
      else if(url.pathname.endsWith('/mock')){assert.equal(route.request().postDataJSON().outcome,'SUCCESS');assert.ok(route.request().headers()['idempotency-key']);confirmed=true;confirmCalls++;data=checkout();}
      else if(url.pathname.includes('/join-requests/'))data=checkout();
      else if(url.pathname.includes('/tickets/'))data={ticket:{id:ticket,queueNumber:'A001',status:'WAITING',version:1,simulatedPayment:mode!=='NONE'},business:{name:'Business'},branch:{name:'Branch',publicSlug:'demo'},service:{id:service,name:'Service'},notifications:[],mockWhatsAppAvailable:false,queue:{peopleAhead:2,estimatedWaitMinutes:10,etaStatus:'AVAILABLE',sessionStatus:'OPEN',nowServing:[],revision:'1',generatedAt:new Date().toISOString(),realtimeTopic:'queue:offline'}};
      else throw new Error('Unexpected offline API path');
      await route.fulfill({json:data});
    });
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:5187/q/demo/services/'+service+'/join');
    await page.getByLabel('Your name').fill('Offline customer');
    await page.getByRole('button',{name:mode==='NONE'?'Join queue':mode==='DEPOSIT'?'Pay deposit & join':'Pay & join',exact:true}).click();
    if(mode!=='NONE'){
      await page.getByRole('heading',{name:'SIMULASI PEMBAYARAN — TIDAK ADA UANG ASLI'}).waitFor();
      assert.equal(confirmCalls,0);
      await page.getByRole('button',{name:'Konfirmasi pembayaran simulasi',exact:true}).click();
    }
    await page.getByTestId('queue-number').waitFor();
    assert.equal(await page.getByTestId('queue-number').innerText(),'A001');
    assert.equal(confirmCalls,mode==='NONE'?0:1);
    if(mode!=='NONE')await page.getByText('SIMULASI PEMBAYARAN — TIDAK ADA UANG ASLI',{exact:true}).waitFor();
    await context.close();
  }
  console.log('Production browser smoke passed: DEPOSIT, FULL, NONE; explicit mock confirmation and demo ticket labels.');
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
