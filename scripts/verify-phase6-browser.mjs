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
Object.assign(process.env,api,{MOCK_WHATSAPP_ENABLED:'true',NODE_ENV:'development',PAYMENT_PROVIDER:'MOCK',PORT:'3106',WEB_ORIGIN:'http://localhost:5178'});
const origin='http://localhost:5178',businessId=randomUUID(),branchId=randomUUID(),serviceId=randomUUID(),paidServiceId=randomUUID(),counterId=randomUUID();
const slug='phase6-browser-'+branchId,result={},logs=[],customerIds=new Set(),errors=[];
let stage='setup',browser,server,vite,pool,owner,createdProfile=false,activeTransactions=0;
const expectPayment=expect.configure({timeout:30000});
const authErrors=[];const databaseErrors=[];mkdirSync('.runtime',{recursive:true});
const progress=setInterval(()=>writeFileSync('.runtime/phase6-progress.json',JSON.stringify({stage,activeTransactions,total:pool?.totalCount,idle:pool?.idleCount,waiting:pool?.waitingCount,databaseErrors})),3000);progress.unref();
async function transaction(operation){
  activeTransactions++;let client;try{client=await pool.connect();await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
  catch(error){databaseErrors.push({stage,code:/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:'ERROR',category:/timeout|timed out/i.test(error?.message??'')?'TIMEOUT':/terminat|closed|reset/i.test(error?.message??'')?'CONNECTION_CLOSED':'OTHER',total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount});if(client)await client.query('ROLLBACK');throw error;}finally{client?.release();activeTransactions--;}
}
try{
  if(!api.TEST_STAFF_EMAIL||!api.TEST_STAFF_PASSWORD)throw new Error('MISSING_CREDENTIALS');
  const {createApp}=await import('../apps/api/src/app.ts');
  const {getSupabaseAuth}=await import('../apps/api/src/config/supabase.ts');
  const authClient=getSupabaseAuth().auth,originalGetUser=authClient.getUser.bind(authClient);
  authClient.getUser=async token=>{
    const response=await originalGetUser(token);
    if(response.error){
      let remaining=null;try{remaining=Math.round(JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).exp-Date.now()/1000);}catch{/* Never retain token contents. */}
      authErrors.push({stage,status:response.error.status,code:/^[a-z0-9_]+$/.test(response.error.code??'')?response.error.code:'AUTH_ERROR',remainingSeconds:remaining});
    }
    return response;
  };
  pool=new pg.Pool({connectionString:api.DATABASE_URL,application_name:'qevra-phase6-browser',max:8,connectionTimeoutMillis:10000});
  owner=(await pool.query('SELECT id FROM auth.users WHERE email=$1 AND email_confirmed_at IS NOT NULL',[api.TEST_STAFF_EMAIL])).rows[0]?.id;
  if(!owner)throw new Error('MISSING_STAFF');
  await transaction(async client=>{
    createdProfile=(await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Development staff') ON CONFLICT DO NOTHING",[owner])).rowCount>0;
    await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Qevra Customer Demo',$2,$3)",[businessId,'phase6-'+businessId,owner]);
    await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[businessId,owner]);
    await client.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,'Central Park',$3,'Asia/Jakarta')",[branchId,businessId,slug]);
    await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode) VALUES($1,$2,$3,'Haircut',100000,30,'H','NONE')",[serviceId,businessId,branchId]);
    await client.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode,deposit_amount) VALUES($1,$2,$3,'Deposit service',500000,60,'D','DEPOSIT',50000)",[paidServiceId,businessId,branchId]);
    await client.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,'Stylist 1')",[counterId,businessId,branchId,serviceId]);

  });
  server=createApp({runTransaction:transaction}).listen(3106);await once(server,'listening');
  vite=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','localhost','--port','5178','--strictPort'],{cwd:resolve('apps/web'),env:{...process.env,VITE_API_URL:'http://localhost:3106/api/v1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  vite.stdout.on('data',chunk=>logs.push(chunk.toString()));vite.stderr.on('data',chunk=>logs.push(chunk.toString()));
  for(let i=0;i<40;i++){try{if((await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{/* Wait for the isolated dev server. */}await delay(250);}
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  function observe(page){page.setDefaultTimeout(45000);page.on('console',message=>logs.push(message.text()));page.on('pageerror',()=>errors.push('page-error'));page.on('response',async response=>{if(response.url().includes('/auth/v1/signup')&&response.ok()){try{const data=await response.json();if(data.user?.is_anonymous&&data.user.id)customerIds.add(data.user.id);}catch{/* No credential output. */}}});}
  const staffContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const staff=await staffContext.newPage();observe(staff);
  stage='staff-login-open';
  await staff.goto(origin+'/app');await staff.waitForURL('**/login');
  await staff.getByLabel('Email',{exact:true}).fill(api.TEST_STAFF_EMAIL);await staff.getByLabel('Password',{exact:true}).fill(api.TEST_STAFF_PASSWORD);
  stage='staff-sign-in';await staff.getByRole('button',{name:'Sign in',exact:true}).click();await staff.getByRole('heading',{name:'Your businesses',exact:true}).waitFor();
  const staffPath='/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/queue';
  stage='staff-open-queue';await staff.goto(origin+staffPath);await staff.getByRole('button',{name:'Open queue',exact:true}).click();
  await staff.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();result.staffOpenedQueue=true;
  const contexts=[],pages=[],ticketIds=[];
  let broadcasts=0;
  async function identity(page){
    const id=await page.evaluate(async()=>{const module=await import('/src/lib/supabase.ts');return (await module.getCustomerSupabase().auth.getSession()).data.session?.user.id;});
    if(id)customerIds.add(id);return id;
  }
  stage='five-customer-join';
  for(const name of ['A','B','C','D','E']){
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();contexts.push(context);pages.push(page);observe(page);
    page.on('websocket',socket=>socket.on('framereceived',event=>{if(String(event.payload).includes('queue_changed'))broadcasts++;}));
    await page.goto(origin+'/q/'+slug);await page.getByRole('link',{name:'Join queue',exact:true}).click();
    await page.getByLabel('Your name',{exact:true}).fill('Customer '+name);
    await expectPayment(page.getByRole('button',{name:'Join queue',exact:true})).toBeEnabled();await identity(page);
    const consent=page.getByRole('checkbox',{name:'Send queue updates to this number via WhatsApp',exact:true});
    await expectPayment(consent).not.toBeChecked();await expectPayment(consent).toBeDisabled();
    if(name==='E'){
      await page.getByLabel('WhatsApp / phone (optional)').fill('081234567890');
      await expectPayment(consent).toBeEnabled();await expectPayment(consent).not.toBeChecked();await consent.check();
    }
    await expectPayment(page.getByRole('button',{name:'Join queue',exact:true})).toBeEnabled();await identity(page);
    await page.getByRole('button',{name:'Join queue',exact:true}).click();await page.waitForURL('**/ticket/*');
    await page.getByText('Updates are live.',{exact:true}).waitFor();await page.getByTestId('notification-QUEUE_JOINED').waitFor();
    ticketIds.push(new URL(page.url()).pathname.split('/')[2]);
  }
  result.fiveJoinedWithUpdates=true;result.consentUncheckedAndPhoneRequired=true;
  const pageE=pages[4],ticketE=ticketIds[4];
  await expectPayment(pageE.getByTestId('people-ahead')).toHaveText('4 people ahead');
  await expectPayment(pageE.getByTestId('notification-NEAR_TURN')).toHaveCount(0);result.noEarlyNearTurn=true;
  await staff.getByRole('button',{name:'Refresh',exact:true}).click();await staff.getByRole('button',{name:'Call H001',exact:true}).waitFor();
  await staff.getByLabel('Available counter').selectOption(counterId);
  async function callNext(){
    await expectPayment(staff.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled({timeout:45000});
    await staff.getByRole('button',{name:'Refresh',exact:true}).click();
    await staff.getByLabel('Available counter').selectOption(counterId);
    await staff.getByRole('button',{name:'Call next',exact:true}).click();
  }
  stage='near-turn-realtime';
  const before=broadcasts;
  await callNext();
  await expectPayment(pages[0].getByTestId('ticket-status')).toHaveText('CALLED');
  await expectPayment(pageE.getByTestId('people-ahead')).toHaveText('3 people ahead');
  await expectPayment(pageE.getByTestId('notification-NEAR_TURN')).toContainText('Only 3 customers are ahead of you.');
  await staff.getByRole('button',{name:'Start service',exact:true}).click();await expectPayment(pages[0].getByTestId('ticket-status')).toHaveText('SERVING');
  await staff.getByRole('button',{name:'Complete',exact:true}).click();await expectPayment(pages[0].getByTestId('ticket-status')).toHaveText('COMPLETED');
  assert.ok(broadcasts>before);result.nearTurnViaExistingRealtime=true;
  mkdirSync('.runtime',{recursive:true});await pageE.screenshot({path:'.runtime/phase6-near-turn-mobile.png',fullPage:true});
  stage='advance-B-C-D';
  for(let index=1;index<4;index++){
    await callNext();await expectPayment(pages[index].getByTestId('ticket-status')).toHaveText('CALLED');
    await staff.getByRole('button',{name:'Start service',exact:true}).click();await expectPayment(pages[index].getByTestId('ticket-status')).toHaveText('SERVING');
    await staff.getByRole('button',{name:'Complete',exact:true}).click();await expectPayment(pages[index].getByTestId('ticket-status')).toHaveText('COMPLETED');
  }
  stage='E-called-started-completed';
  await callNext();
  await expectPayment(pageE.getByTestId('notification-YOUR_TURN')).toContainText("It's your turn. Please return to the service area.");
  await staff.getByRole('button',{name:'Start service',exact:true}).click();await expectPayment(pageE.getByTestId('notification-SERVICE_STARTED')).toContainText('Your service has started.');
  await staff.getByRole('button',{name:'Complete',exact:true}).click();await expectPayment(pageE.getByTestId('notification-SERVICE_COMPLETED')).toContainText('Your service is complete. Thank you.');
  result.turnStartCompleteUpdates=true;
  stage='mock-whatsapp-inspection';
  await pageE.getByRole('button',{name:'Inspect mock WhatsApp',exact:true}).click();
  await pageE.getByRole('heading',{name:'MOCK WHATSAPP',exact:true}).waitFor();
  for(const type of ['QUEUE_JOINED','NEAR_TURN','YOUR_TURN','SERVICE_STARTED','SERVICE_COMPLETED']){
    await expectPayment(pageE.getByTestId('mock-'+type)).toHaveCount(1);
    await expectPayment(pageE.getByTestId('mock-'+type)).toContainText('Recipient: +62*******7890');
  }
  assert.ok(!(await pageE.getByTestId('mock-whatsapp').innerText()).includes('6281234567890'));result.matchingMaskedMockMessages=true;
  await pages[0].getByRole('button',{name:'Inspect mock WhatsApp',exact:true}).click();
  await expectPayment(pages[0].getByTestId('mock-whatsapp')).toContainText('No simulated messages.');result.noConsentNoMock=true;
  stage='read-refresh-deduplication';
  await pageE.getByTestId('notification-QUEUE_JOINED').getByRole('button',{name:'Mark as read',exact:true}).click();
  await expectPayment(pageE.getByTestId('notification-QUEUE_JOINED').getByRole('button',{name:'Mark as read',exact:true})).toHaveCount(0);
  await pageE.reload();await pageE.getByText('Updates are live.',{exact:true}).waitFor();
  await expectPayment(pageE.getByTestId('notification-QUEUE_JOINED').getByRole('button',{name:'Mark as read',exact:true})).toHaveCount(0);
  await pageE.getByRole('button',{name:'Refresh ticket',exact:true}).click();
  await expectPayment(pageE.getByTestId('notification-NEAR_TURN')).toHaveCount(1);
  const counts=(await pool.query('SELECT channel,type,count(*)::int AS n FROM public.notifications WHERE queue_ticket_id=$1 GROUP BY channel,type',[ticketE])).rows;
  assert.equal(counts.length,10);assert.ok(counts.every(row=>row.n===1));result.readStatePersistsAndNoDuplicates=true;
  stage='customer-isolation';
  const notificationId=(await pool.query("SELECT id FROM public.notifications WHERE queue_ticket_id=$1 AND channel='IN_APP' LIMIT 1",[ticketE])).rows[0].id;
  const denied=await pages[0].evaluate(async({ticketE,notificationId})=>{
    const {customerRequest}=await import('/src/lib/customer-api.ts');const results=[];
    for(const path of ['/tickets/'+ticketE,'/tickets/'+ticketE+'/mock-whatsapp','/notifications/'+notificationId+'/read']){
      try{await customerRequest(path,path.endsWith('/read')?{body:{}}:{});results.push(200);}catch(error){results.push(error.status);}
    }return results;
  },{ticketE,notificationId});assert.deepEqual(denied,[404,404,404]);result.otherCustomerAccessDenied=true;
  result.mobileNoOverflow=await pageE.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  await pageE.screenshot({path:'.runtime/phase6-updates-mobile.png',fullPage:true});
  await pageE.getByRole('button',{name:'Inspect mock WhatsApp',exact:true}).click();await pageE.getByTestId('mock-SERVICE_COMPLETED').waitFor();
  await pageE.screenshot({path:'.runtime/phase6-mock-whatsapp-mobile.png',fullPage:true});
  result.noUncaughtBrowserErrors=errors.length===0;
  if(Object.values(result).some(value=>value===false))throw new Error('BROWSER_ASSERTION');
  for(const context of contexts)await context.close();await staffContext.close();
}catch(error){
  result.failureStage=stage;
  if(browser){result.visibleHeadings=[];for(const context of browser.contexts())for(const page of context.pages())result.visibleHeadings.push(await page.getByRole('heading').allTextContents().catch(()=>[]));}
  result.errorKind=error?.name;
  if(browser){result.visibleAlerts=[];for(const context of browser.contexts())for(const page of context.pages())result.visibleAlerts.push(await page.getByRole('alert').allTextContents().catch(()=>[]));}
  let detail=String(error?.message??'');for(const value of [...Object.values(api),...Object.values(web)].filter(v=>v.length>5))detail=detail.split(value).join('[redacted]');result.failureDetail=detail.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token]').slice(0,1600);
  result.failureCode=typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'BROWSER_CHECK_FAILED';
  process.exitCode=1;
}finally{
  clearInterval(progress);result.databaseErrors=databaseErrors;result.authErrors=authErrors;
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
  mkdirSync('.runtime',{recursive:true});writeFileSync('.runtime/phase6-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
