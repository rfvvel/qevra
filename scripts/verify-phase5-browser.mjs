import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {parse} from 'dotenv';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {chromium,expect} from '@playwright/test';
const api=parse(readFileSync('apps/api/.env')),web=parse(readFileSync('apps/web/.env'));
Object.assign(process.env,api,{NODE_ENV:'development',PAYMENT_PROVIDER:'MOCK',PORT:'3105',WEB_ORIGIN:'http://localhost:5177'});
const origin='http://localhost:5177',businessId=randomUUID(),branchId=randomUUID(),serviceId=randomUUID(),paidServiceId=randomUUID(),counterId=randomUUID();
const slug='phase5-browser-'+branchId,result={},logs=[],customerIds=new Set(),errors=[];
let stage='setup',browser,server,vite,pool,owner,createdProfile=false,activeTransactions=0;
const expectPayment=expect.configure({timeout:30000});
async function transaction(operation){
  activeTransactions++;let client;try{client=await pool.connect();await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
  catch(error){if(client)await client.query('ROLLBACK');throw error;}finally{client?.release();activeTransactions--;}
}
try{
  if(!api.TEST_STAFF_EMAIL||!api.TEST_STAFF_PASSWORD)throw new Error('MISSING_CREDENTIALS');
  const {createApp}=await import('../apps/api/src/app.ts');
  pool=new pg.Pool({connectionString:api.DATABASE_URL,max:8,connectionTimeoutMillis:10000});
  owner=(await pool.query('SELECT id FROM auth.users WHERE email=$1 AND email_confirmed_at IS NOT NULL',[api.TEST_STAFF_EMAIL])).rows[0]?.id;
  if(!owner)throw new Error('MISSING_STAFF');
  await transaction(async client=>{
    createdProfile=(await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Development staff') ON CONFLICT DO NOTHING",[owner])).rowCount>0;
    await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Qevra Customer Demo',$2,$3)",[businessId,'phase5-'+businessId,owner]);
    await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[businessId,owner]);
    await client.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,'Central Park',$3,'Asia/Jakarta')",[branchId,businessId,slug]);
    await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode) VALUES($1,$2,$3,'Full service',100000,30,'F','FULL')",[serviceId,businessId,branchId]);
    await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode,deposit_amount) VALUES($1,$2,$3,'Deposit service',500000,60,'D','DEPOSIT',50000)",[paidServiceId,businessId,branchId]);
    await client.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,'Stylist 1')",[counterId,businessId,branchId,serviceId]);
    await client.query("INSERT INTO public.service_counters(business_id,branch_id,service_id,name) VALUES($1,$2,$3,'Stylist 2')",[businessId,branchId,serviceId]);
  });
  server=createApp({runTransaction:transaction}).listen(3105);await once(server,'listening');
  vite=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','localhost','--port','5177','--strictPort'],{cwd:resolve('apps/web'),env:{...process.env,VITE_API_URL:'http://localhost:3105/api/v1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  vite.stdout.on('data',chunk=>logs.push(chunk.toString()));vite.stderr.on('data',chunk=>logs.push(chunk.toString()));
  for(let i=0;i<40;i++){try{if((await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{/* Wait for the isolated dev server. */}await delay(250);}
  browser=await chromium.launch({channel:'msedge',headless:true});
  function observe(page){page.setDefaultTimeout(25000);page.on('console',message=>logs.push(message.text()));page.on('pageerror',()=>errors.push('page-error'));}
  const staffContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const staff=await staffContext.newPage();observe(staff);
  stage='staff-login-open';
  await staff.goto(origin+'/app');await staff.waitForURL('**/login');
  await staff.getByLabel('Email',{exact:true}).fill(api.TEST_STAFF_EMAIL);await staff.getByLabel('Password',{exact:true}).fill(api.TEST_STAFF_PASSWORD);
  stage='staff-sign-in';await staff.getByRole('button',{name:'Sign in',exact:true}).click();await staff.getByRole('heading',{name:'Your businesses',exact:true}).waitFor();
  const staffPath='/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/queue';
  stage='staff-open-queue';await staff.goto(origin+staffPath);await staff.getByRole('button',{name:'Open queue',exact:true}).click();
  await staff.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();result.staffOpenedQueue=true;
  const contextA=await browser.newContext({viewport:{width:390,height:844}});
  const pageA=await contextA.newPage();observe(pageA);
  let signups=0,broadcasts=0;
  pageA.on('request',request=>{if(request.url().includes('/auth/v1/signup'))signups++;});
  pageA.on('websocket',socket=>socket.on('framereceived',event=>{if(String(event.payload).includes('queue_changed'))broadcasts++;}));
  async function identity(page){
    const id=await page.evaluate(async()=>{const module=await import('/src/lib/supabase.ts');return (await module.getCustomerSupabase().auth.getSession()).data.session?.user.id;});
    if(id)customerIds.add(id);return id;
  }
  async function join(page,button,name){
    await page.goto(origin+'/q/'+slug);
    await page.getByRole('link',{name:button,exact:true}).click();
    await page.getByLabel('Your name',{exact:true}).fill(name);
    await expectPayment(page.getByRole('button',{name:button,exact:true})).toBeEnabled();await identity(page);
    await page.getByRole('button',{name:button,exact:true}).click();
    await page.waitForURL('**/checkout/*');await page.getByRole('heading',{name:'Development Mock Payment',exact:true}).waitFor();
    return new URL(page.url()).pathname.split('/')[2];
  }
  async function noTicket(id){
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.queue_tickets WHERE join_request_id=$1',[id])).rows[0].n,0);
  }
  stage='full-checkout';
  const fullId=await join(pageA,'Pay & join','Full customer');
  await expectPayment(pageA.getByTestId('pay-now')).toHaveText(/100.000/);await noTicket(fullId);result.fullPendingWithoutTicket=true;
  const firstIdentity=await identity(pageA),signupCount=signups;
  await pageA.reload();await pageA.getByRole('heading',{name:'Waiting for payment',exact:true}).waitFor();
  assert.equal(await identity(pageA),firstIdentity);assert.equal(signups,signupCount);result.checkoutSessionPersists=true;
  result.noCustomerLogin=await pageA.getByLabel('Password',{exact:true}).count()===0;
  mkdirSync('.runtime',{recursive:true});await pageA.screenshot({path:'.runtime/phase5-full-checkout-mobile.png',fullPage:true});
  stage='full-success';
  await pageA.getByRole('button',{name:'Simulate Successful Payment',exact:true}).click();await pageA.waitForURL('**/ticket/*');
  await expectPayment(pageA.getByTestId('queue-number')).toHaveText('F001');await pageA.getByText('Updates are live.',{exact:true}).waitFor();result.fullPaidAdmission=true;
  stage='paid-ticket-staff-realtime';
  await staff.getByRole('button',{name:'Refresh',exact:true}).click();await staff.getByRole('button',{name:'Call F001',exact:true}).waitFor();
  await staff.getByLabel('Available counter').selectOption(counterId);
  const framesBefore=broadcasts;stage='paid-realtime-called';
  await staff.getByRole('button',{name:'Call next',exact:true}).click();await expectPayment(pageA.getByTestId('ticket-status')).toHaveText('CALLED',{timeout:30000});
  stage='paid-realtime-serving';await staff.getByRole('button',{name:'Start service',exact:true}).click();await expectPayment(pageA.getByTestId('ticket-status')).toHaveText('SERVING',{timeout:30000});
  stage='paid-realtime-completed';await staff.getByRole('button',{name:'Complete',exact:true}).click();await expectPayment(pageA.getByTestId('ticket-status')).toHaveText('COMPLETED',{timeout:30000});
  assert.ok(broadcasts>framesBefore);result.paidTicketRealtimeCalledServingCompleted=true;
  stage='deposit-open';
  await staff.goto(origin+'/app/'+businessId+'/branches/'+branchId+'/services/'+paidServiceId+'/queue');
  await staff.getByRole('button',{name:'Open queue',exact:true}).click();await staff.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();
  stage='deposit-checkout';
  const depositId=await join(pageA,'Pay deposit & join','Deposit customer');
  await expectPayment(pageA.getByTestId('service-price')).toHaveText(/500.000/);
  await expectPayment(pageA.getByTestId('pay-now')).toHaveText(/50.000/);
  await expectPayment(pageA.getByTestId('remaining-payment')).toHaveText(/450.000/);await noTicket(depositId);result.depositPricingAndPending=true;
  result.mobileNoOverflow=await pageA.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  await pageA.screenshot({path:'.runtime/phase5-deposit-checkout-mobile.png',fullPage:true});
  stage='failure-expiry-retry';
  await pageA.getByRole('button',{name:'Simulate Failed Payment',exact:true}).click();await expectPayment(pageA.getByTestId('payment-status')).toHaveText('FAILED');await noTicket(depositId);
  await pageA.getByRole('button',{name:'Try Again',exact:true}).click();await expectPayment(pageA.getByTestId('payment-status')).toHaveText('PENDING');
  await pageA.getByRole('button',{name:'Simulate Expired Payment',exact:true}).click();await expectPayment(pageA.getByTestId('payment-status')).toHaveText('EXPIRED');await noTicket(depositId);
  await pageA.getByRole('button',{name:'Create New Payment',exact:true}).click();await expectPayment(pageA.getByTestId('payment-status')).toHaveText('PENDING');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.payments WHERE join_request_id=$1',[depositId])).rows[0].n,3);
  result.failedExpiredRetryHistory=true;
  stage='deposit-success';
  await pageA.getByRole('button',{name:'Simulate Successful Payment',exact:true}).click();await pageA.waitForURL('**/ticket/*');
  await expectPayment(pageA.getByTestId('queue-number')).toHaveText('D001');await pageA.getByText('Updates are live.',{exact:true}).waitFor();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.queue_tickets WHERE join_request_id=$1',[depositId])).rows[0].n,1);result.depositPaidAdmission=true;
  await pageA.screenshot({path:'.runtime/phase5-paid-ticket-mobile.png',fullPage:true});
  stage='reconciliation-checkout';
  const contextB=await browser.newContext({viewport:{width:390,height:844}}),pageB=await contextB.newPage();observe(pageB);
  const reconcileId=await join(pageB,'Pay deposit & join','Reconciliation customer');
  await staff.getByRole('button',{name:'Pause queue',exact:true}).click();await staff.getByRole('heading',{name:'Queue: PAUSED',exact:true}).waitFor();
  await pageB.getByRole('button',{name:'Simulate Successful Payment',exact:true}).click();
  await pageB.getByText('Payment was received, but your queue ticket could not be created. Please contact the service provider.',{exact:true}).waitFor();
  await expectPayment(pageB.getByTestId('payment-status')).toHaveText('PAID');await noTicket(reconcileId);
  await pageB.reload();await pageB.getByRole('heading',{name:'Payment received — assistance needed',exact:true}).waitFor();
  await pageB.screenshot({path:'.runtime/phase5-reconciliation-mobile.png',fullPage:true});result.reconciliationVisibleAndPersistent=true;
  result.noUncaughtBrowserErrors=errors.length===0;
  if(Object.values(result).some(value=>value===false))throw new Error('BROWSER_ASSERTION');
  await contextA.close();await contextB.close();await staffContext.close();
}catch(error){
  result.failureStage=stage;
  if(browser){result.visibleHeadings=[];for(const context of browser.contexts())for(const page of context.pages())result.visibleHeadings.push(await page.getByRole('heading').allTextContents().catch(()=>[]));}
  result.errorKind=error?.name;
  let detail=String(error?.message??'');for(const value of [...Object.values(api),...Object.values(web)].filter(v=>v.length>5))detail=detail.split(value).join('[redacted]');result.failureDetail=detail.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token]').slice(0,1600);
  result.failureCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'BROWSER_CHECK_FAILED';
  process.exitCode=1;
}finally{
  await browser?.close().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(vite)vite.kill();
  for(let i=0;activeTransactions&&i<240;i++)await delay(250);
  if(pool){
    try{
      // These UUIDs belong exclusively to this run. Real staff identity is retained.
      await transaction(async client=>{
        const rows=await client.query('SELECT DISTINCT customer_auth_id FROM public.join_requests WHERE business_id=$1',[businessId]);
        for(const row of rows.rows)customerIds.add(row.customer_auth_id);
        for(const table of ['queue_command_keys','queue_events','queue_tickets','payment_events','payments','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])
          await client.query('DELETE FROM public.'+table+' WHERE business_id=$1',[businessId]);
        await client.query('DELETE FROM public.businesses WHERE id=$1',[businessId]);
        if(createdProfile)await client.query('DELETE FROM public.profiles p WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM public.business_members m WHERE m.user_id=p.user_id) AND NOT EXISTS(SELECT 1 FROM public.businesses b WHERE b.created_by=p.user_id)',[owner]);
        if(customerIds.size)await client.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[]) AND is_anonymous',[[...customerIds]]);
      });result.fixturesCleaned=true;
    }catch(error){result.fixturesCleaned=false;result.cleanupCode=/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:'CLEANUP_FAILED';process.exitCode=1;}
    await pool.end();
  }
  const secrets=[...Object.entries(api),...Object.entries(web)].filter(([key,value])=>/KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(key)&&value.length>5).map(([,value])=>value);
  try{secrets.push(decodeURIComponent(new URL(api.DATABASE_URL).password));}catch{/* Never log credentials. */}
  result.noCredentialsInLogs=!secrets.some(secret=>logs.join('').includes(secret))&&!/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(logs.join(''));
  if(!result.noCredentialsInLogs)process.exitCode=1;
  mkdirSync('.runtime',{recursive:true});writeFileSync('.runtime/phase5-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
