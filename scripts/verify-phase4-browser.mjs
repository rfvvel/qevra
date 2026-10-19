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
Object.assign(process.env,api,{PORT:'3104',WEB_ORIGIN:'http://localhost:5176'});
const origin='http://localhost:5176',businessId=randomUUID(),branchId=randomUUID(),serviceId=randomUUID(),paidServiceId=randomUUID(),counterId=randomUUID();
const asStaff=process.argv.includes('--as-staff'),fixtureOwner=randomUUID();
const slug='phase4-browser-'+branchId,result={},logs=[],customerIds=new Set(),errors=[];
let stage='setup',browser,server,vite,pool,owner,createdProfile=false;
async function transaction(operation){
  const client=await pool.connect();try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
try{
  if(!api.TEST_STAFF_EMAIL||!api.TEST_STAFF_PASSWORD)throw new Error('MISSING_CREDENTIALS');
  const {createApp}=await import('../apps/api/src/app.ts');
  pool=new pg.Pool({connectionString:api.DATABASE_URL,max:8,connectionTimeoutMillis:10000});
  owner=(await pool.query('SELECT id FROM auth.users WHERE email=$1 AND email_confirmed_at IS NOT NULL',[api.TEST_STAFF_EMAIL])).rows[0]?.id;
  if(!owner)throw new Error('MISSING_STAFF');
  await transaction(async client=>{
    if(asStaff){await client.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,false)',[fixtureOwner]);await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Fixture owner')",[fixtureOwner]);}
    createdProfile=(await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Development staff') ON CONFLICT DO NOTHING",[owner])).rowCount>0;
    await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Qevra Customer Demo',$2,$3)",[businessId,'phase4-'+businessId,owner]);
    await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[businessId,owner]);
    await client.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,'Central Park',$3,'Asia/Jakarta')",[branchId,businessId,slug]);
    await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode) VALUES($1,$2,$3,'Haircut',80000,30,'H','NONE')",[serviceId,businessId,branchId]);
    await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode,deposit_amount) VALUES($1,$2,$3,'Coloring',200000,60,'C','DEPOSIT',50000)",[paidServiceId,businessId,branchId]);
    await client.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,'Stylist 1')",[counterId,businessId,branchId,serviceId]);
    await client.query("INSERT INTO public.service_counters(business_id,branch_id,service_id,name) VALUES($1,$2,$3,'Stylist 2')",[businessId,branchId,serviceId]);
    if(asStaff){await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[businessId,fixtureOwner]);await client.query("UPDATE public.business_members SET role='STAFF' WHERE business_id=$1 AND user_id=$2",[businessId,owner]);await client.query('INSERT INTO public.branch_members(business_id,branch_id,member_id) SELECT $1,$2,id FROM public.business_members WHERE business_id=$1 AND user_id=$3',[businessId,branchId,owner]);await client.query('INSERT INTO public.staff_services(business_id,branch_id,service_id,member_id) SELECT $1,$2,$3,id FROM public.business_members WHERE business_id=$1 AND user_id=$4',[businessId,branchId,serviceId,owner]);}
  });
  server=createApp({runTransaction:transaction}).listen(3104);await once(server,'listening');
  vite=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','localhost','--port','5176','--strictPort'],{cwd:resolve('apps/web'),env:{...process.env,VITE_API_URL:'http://localhost:3104/api/v1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  vite.stdout.on('data',chunk=>logs.push(chunk.toString()));vite.stderr.on('data',chunk=>logs.push(chunk.toString()));
  for(let i=0;i<40;i++){try{if((await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{/* Wait for the isolated dev server. */}await delay(250);}
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  function observe(page){page.setDefaultTimeout(25000);page.on('console',message=>logs.push(message.text()));page.on('pageerror',()=>errors.push('page-error'));}
  const staffContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const staff=await staffContext.newPage();observe(staff);
  stage='staff-login-open';
  await staff.goto(origin+'/app');await staff.waitForURL('**/login');
  await staff.getByLabel('Email',{exact:true}).fill(api.TEST_STAFF_EMAIL);await staff.getByLabel('Password',{exact:true}).fill(api.TEST_STAFF_PASSWORD);
  await staff.getByRole('button',{name:'Sign in',exact:true}).click();await staff.getByRole('heading',{name:'Your businesses',exact:true}).waitFor();
  const staffPath='/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/queue';
  await staff.goto(origin+staffPath);await staff.getByRole('button',{name:'Open queue',exact:true}).click();
  await staff.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();result.staffOpenedQueue=true;
  const contextA=await browser.newContext({viewport:{width:390,height:844}}),contextB=await browser.newContext({viewport:{width:390,height:844}});
  const pageA=await contextA.newPage(),pageB=await contextB.newPage();observe(pageA);observe(pageB);
  let signups=0,broadcasts=0;
  for(const page of [pageA,pageB]){
    page.on('request',request=>{if(request.url().includes('/auth/v1/signup'))signups++;});
    page.on('websocket',socket=>{socket.on('framereceived',event=>{if(String(event.payload).includes('queue_changed'))broadcasts++;});});
  }
  async function identity(page){
    const id=await page.evaluate(async()=>{const module=await import('/src/lib/supabase.ts');return (await module.getCustomerSupabase().auth.getSession()).data.session?.user.id;});
    if(id)customerIds.add(id);return id;
  }
  async function join(page,name){
    await page.goto(origin+'/q/'+slug);
    await page.getByRole('heading',{name:'Coloring',exact:true}).waitFor();
    await page.getByRole('link',{name:'Join queue',exact:true}).click();
    await page.getByLabel('Your name',{exact:true}).fill(name);
    await expect(page.getByRole('button',{name:'Join queue',exact:true})).toBeEnabled();
    await identity(page);
    await page.getByRole('button',{name:'Join queue',exact:true}).click();
    await page.waitForURL('**/ticket/*');
    await page.getByText('Updates are live.',{exact:true}).waitFor();
    return new URL(page.url()).pathname.split('/')[2];
  }
  stage='browse-without-identity';
  await pageA.goto(origin+'/q/'+slug);await pageA.getByRole('heading',{name:'Choose a service'}).waitFor();
  assert.equal(signups,0);result.browsingDoesNotCreateIdentity=true;
  stage='customer-A-join';
  const ticketA=await join(pageA,'Customer A');await expect(pageA.getByTestId('queue-number')).toHaveText('H001');result.firstCustomerNumber=true;
  stage='customer-B-join';
  const ticketB=await join(pageB,'Customer B');await expect(pageB.getByTestId('queue-number')).toHaveText('H002');await expect(pageB.getByTestId('people-ahead')).toHaveText('1 person ahead');result.secondCustomerAndPeopleAhead=true;
  result.noCustomerAuthScreen=await pageB.getByLabel('Password',{exact:true}).count()===0 && await pageB.getByRole('button',{name:'Sign in',exact:true}).count()===0;
  stage='ownership-and-private-channel';
  const ownership=await pageB.evaluate(async id=>{
    const {customerRequest}=await import('/src/lib/customer-api.ts');
    const statuses=[];
    for(const path of ['/tickets/'+id,'/tickets/'+id+'/cancel']){
      try{await customerRequest(path,path.endsWith('/cancel')?{body:{expectedVersion:1},key:crypto.randomUUID()}:{});statuses.push(200);}
      catch(error){statuses.push(error.status);}
    }return statuses;
  },ticketA);assert.deepEqual(ownership,[404,404]);result.crossCustomerDenied=true;
  const topic=await pageA.evaluate(async id=>{const {customerRequest}=await import('/src/lib/customer-api.ts');return (await customerRequest('/tickets/'+id)).queue.realtimeTopic;},ticketA);
  const contextC=await browser.newContext(),pageC=await contextC.newPage();observe(pageC);await pageC.goto(origin+'/q/'+slug);
  await pageC.evaluate(async()=>{await (await import('/src/lib/auth.ts')).ensureCustomerSession();});await identity(pageC);
  const denied=await pageC.evaluate(async topic=>{
    const client=(await import('/src/lib/supabase.ts')).getCustomerSupabase();
    const session=(await client.auth.getSession()).data.session;await client.realtime.setAuth(session.access_token);
    return await new Promise(resolve=>{
      let channel;const timer=setTimeout(()=>{void client.removeChannel(channel);resolve('TIMEOUT');},15000);
      channel=client.channel(topic,{config:{private:true}}).subscribe(status=>{
        if(status==='SUBSCRIBED'||status==='CHANNEL_ERROR'){clearTimeout(timer);void client.removeChannel(channel);resolve(status);}
      });
    });
  },topic);assert.equal(denied,'CHANNEL_ERROR');result.unownedRealtimeTopicDenied=true;
  await contextC.close();
  stage='refresh-and-existing-ticket';
  const identityB=await identity(pageB),signupCount=signups;
  await pageB.reload();await pageB.getByText('Updates are live.',{exact:true}).waitFor();assert.equal(await identity(pageB),identityB);
  await pageB.evaluate(()=>localStorage.removeItem('qevra-ticket-references'));
  await pageB.goto(origin+'/ticket/'+ticketB);await expect(pageB.getByTestId('queue-number')).toHaveText('H002');
  await pageB.goto(origin+'/q/'+slug+'/services/'+serviceId+'/join');await pageB.waitForURL('**/ticket/'+ticketB);
  assert.equal(signups,signupCount);result.identityAndExactUrlPersist=true;result.existingTicketRedirect=true;
  await pageB.goto(origin+'/');await pageB.getByRole('link',{name:/View your ticket H002/}).click();await pageB.getByText('Updates are live.',{exact:true}).waitFor();result.restoredTicketShortcut=true;
  stage='realtime-called';
  await staff.getByRole('button',{name:'Refresh',exact:true}).click();await staff.getByRole('button',{name:'Call H001',exact:true}).waitFor();
  await staff.getByLabel('Available counter').selectOption(counterId);
  const framesBefore=broadcasts;
  const callResponse=staff.waitForResponse(r=>r.url().endsWith('/queue/call-next')&&r.request().method()==='POST');
  await staff.getByRole('button',{name:'Call next',exact:true}).click();
  const called=await callResponse;if(!called.ok()){const body=await called.json();throw new Error('CALL_FAILED_'+called.status()+'_'+body.error?.code);}
  await expect(pageA.getByTestId('ticket-status')).toHaveText('CALLED',{timeout:15000});
  await expect(pageB.getByTestId('people-ahead')).toHaveText('0 people ahead',{timeout:15000});
  assert.ok(broadcasts>framesBefore);result.committedRealtimeCallAndPosition=true;
  stage='realtime-serving-completed';
  await staff.getByRole('button',{name:'Start service',exact:true}).click();await expect(pageA.getByTestId('ticket-status')).toHaveText('SERVING',{timeout:15000});
  await staff.getByRole('button',{name:'Complete',exact:true}).click();await expect(pageA.getByTestId('ticket-status')).toHaveText('COMPLETED',{timeout:15000});
  result.realtimeServingAndCompleted=true;
  stage='fallback';
  await pageB.evaluate(async()=>{const client=(await import('/src/lib/supabase.ts')).getCustomerSupabase();await client.removeAllChannels();});
  await staff.getByRole('button',{name:'Call next',exact:true}).click();
  await expect(pageB.getByTestId('ticket-status')).toHaveText('CALLED',{timeout:45000});result.disconnectedPollingFallback=true;
  stage='visibility-refetch';
  await staff.getByRole('button',{name:'Skip',exact:true}).click();
  await staff.getByRole('button',{name:'Requeue',exact:true}).waitFor();
  await pageB.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await expect(pageB.getByTestId('ticket-status')).toHaveText('SKIPPED',{timeout:15000});result.visibilityRefetch=true;
  stage='reconnect-refetch';
  await pageB.reload();await pageB.getByText('Updates are live.',{exact:true}).waitFor();
  await staff.getByRole('button',{name:'Requeue',exact:true}).click();await expect(pageB.getByTestId('ticket-status')).toHaveText('WAITING',{timeout:15000});result.reconnectRefetch=true;
  stage='mobile-privacy';
  assert.ok(!(await pageB.locator('body').innerText()).includes('Customer A'));
  result.mobileNoOverflow=await pageB.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  mkdirSync('.runtime',{recursive:true});await pageB.screenshot({path:'.runtime/phase4-ticket-mobile.png',fullPage:true});
  await pageB.setViewportSize({width:1280,height:900});await pageB.screenshot({path:'.runtime/phase4-ticket-desktop.png',fullPage:true});
  stage='cancel-confirmation';
  await pageB.getByRole('button',{name:'Leave queue',exact:true}).click();await pageB.getByRole('button',{name:'Keep my place',exact:true}).click();
  await expect(pageB.getByTestId('ticket-status')).toHaveText('WAITING');
  await pageB.getByRole('button',{name:'Leave queue',exact:true}).click();await pageB.getByRole('button',{name:'Yes, leave queue',exact:true}).click();
  await expect(pageB.getByTestId('ticket-status')).toHaveText('CANCELLED',{timeout:15000});result.confirmedOwnCancellation=true;
  result.noUncaughtBrowserErrors=errors.length===0;
  if(Object.values(result).some(value=>value===false))throw new Error('BROWSER_ASSERTION');
  await contextA.close();await contextB.close();await staffContext.close();
}catch(error){
  result.failureStage=stage;
  let detail=String(error?.message??'');for(const value of [...Object.values(api),...Object.values(web)].filter(v=>v.length>5))detail=detail.split(value).join('[redacted]');result.failureDetail=detail.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token]').slice(0,1600);
  result.failureCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'BROWSER_CHECK_FAILED';
  process.exitCode=1;
}finally{
  await browser?.close().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(vite)vite.kill();
  if(pool){
    try{
      // These UUIDs belong exclusively to this run. Real staff identity is retained.
      await transaction(async client=>{
        const rows=await client.query('SELECT DISTINCT customer_auth_id FROM public.join_requests WHERE business_id=$1',[businessId]);
        for(const row of rows.rows)customerIds.add(row.customer_auth_id);
        for(const table of ['queue_command_keys','queue_events','queue_tickets','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])
          await client.query('DELETE FROM public.'+table+' WHERE business_id=$1',[businessId]);
        await client.query('DELETE FROM public.businesses WHERE id=$1',[businessId]);
        if(asStaff){await client.query('DELETE FROM public.profiles WHERE user_id=$1',[fixtureOwner]);await client.query('DELETE FROM auth.users WHERE id=$1',[fixtureOwner]);}
        if(createdProfile)await client.query('DELETE FROM public.profiles p WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM public.business_members m WHERE m.user_id=p.user_id) AND NOT EXISTS(SELECT 1 FROM public.businesses b WHERE b.created_by=p.user_id)',[owner]);
        if(customerIds.size)await client.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[]) AND is_anonymous',[[...customerIds]]);
      });result.fixturesCleaned=true;
    }catch{result.fixturesCleaned=false;process.exitCode=1;}
    await pool.end();
  }
  const secrets=[...Object.entries(api),...Object.entries(web)].filter(([key,value])=>/KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(key)&&value.length>5).map(([,value])=>value);
  try{secrets.push(decodeURIComponent(new URL(api.DATABASE_URL).password));}catch{/* Never log credentials. */}
  result.noCredentialsInLogs=!secrets.some(secret=>logs.join('').includes(secret))&&!/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(logs.join(''));
  if(!result.noCredentialsInLogs)process.exitCode=1;
  mkdirSync('.runtime',{recursive:true});writeFileSync(asStaff?'.runtime/phase8-staff-browser.json':'.runtime/phase4-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
