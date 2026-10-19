import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parse} from 'dotenv';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {chromium,expect as baseExpect} from '@playwright/test';
const api=parse(readFileSync('apps/api/.env')),web=parse(readFileSync('apps/web/.env'));
Object.assign(process.env,api,{NODE_ENV:'development',PAYMENT_PROVIDER:'MOCK',MOCK_WHATSAPP_ENABLED:'true',WEB_ORIGIN:'http://localhost:5180',PORT:'3108'});
const origin='http://localhost:5180',expect=baseExpect.configure({timeout:45000}),tag=randomUUID().slice(0,8),password='Qevra8!'+randomUUID();
const [local,domain]=(api.TEST_STAFF_EMAIL??'').split('@');
if(!local||!domain)throw new Error('Configured development test email is required.');
// Aliases deliver only to the configured development test inbox; never arbitrary recipients.
const ownerEmail=local.split('+')[0]+'+qevra8-'+tag+'-owner@'+domain,staffEmail=local.split('+')[0]+'+qevra8-'+tag+'-staff@'+domain;
const result={},logs=[],errors=[],users=new Set();let browser,server,vite,pool,businessId,branchId,serviceId,counterId,stage='setup',active=0;
mkdirSync('.runtime',{recursive:true});
const progress=setInterval(()=>writeFileSync('.runtime/phase8-progress.json',JSON.stringify({stage,active})),3000);progress.unref();
async function run(op){active++;let c;try{c=await pool.connect();await c.query('BEGIN');const v=await op(c);await c.query('COMMIT');return v;}catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();active--;}}
try{
 const {createApp}=await import('../apps/api/src/app.ts');pool=new pg.Pool({connectionString:api.DATABASE_URL,max:8,connectionTimeoutMillis:15000});
 server=createApp({runTransaction:run}).listen(3108);await once(server,'listening');
 vite=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','localhost','--port','5180','--strictPort'],{cwd:resolve('apps/web'),env:{...process.env,VITE_API_URL:'http://localhost:3108/api/v1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 vite.stdout.on('data',c=>logs.push(c.toString()));vite.stderr.on('data',c=>logs.push(c.toString()));
 for(let i=0;i<60;i++){try{if((await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{/* Wait for Vite. */}await delay(250);}
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 async function pageFor(width=1440){const context=await browser.newContext({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']});const p=await context.newPage();p.setDefaultTimeout(45000);p.on('console',m=>logs.push(m.text()));p.on('pageerror',()=>errors.push('page-error'));p.on('dialog',d=>d.accept());return p;}
 async function login(p,email){await p.goto(origin+'/login');await p.getByLabel('Email',{exact:true}).fill(email);await p.getByLabel('Password',{exact:true}).fill(password);await p.getByLabel('Password',{exact:true}).press('Enter');await p.getByRole('heading',{name:'Your businesses',exact:true}).waitFor();}
 async function register(p,email,name){
  if(process.argv.includes('--fixture-accounts')){
   const id=randomUUID();users.add(id);
   await pool.query("INSERT INTO auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change,is_anonymous) VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,extensions.crypt($3,extensions.gen_salt('bf')),now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}'::jsonb,jsonb_build_object('full_name',$4::text),now(),now(),'','','','',false)",[id,email,password,name]);
   await login(p,email);return id;
  }
  await p.goto(origin+'/register');await p.getByLabel('Name',{exact:true}).fill(name);await p.getByLabel('Email',{exact:true}).fill(email);await p.getByLabel('Password',{exact:true}).fill(password);await p.getByLabel('Confirm password',{exact:true}).fill('not-the-same-password');
  await p.getByRole('button',{name:'Create account',exact:true}).click();await expect(p.getByRole('alert')).toContainText('Passwords do not match.');result.passwordMismatchValidated=true;
  await p.getByLabel('Confirm password',{exact:true}).fill(password);
  const responsePromise=p.waitForResponse(r=>r.url().includes('/auth/v1/signup')&&r.request().method()==='POST');
  await p.getByRole('button',{name:'Create account',exact:true}).click();const response=await responsePromise;
  if(!response.ok()){const d=await response.json();throw new Error('REGISTRATION_'+response.status()+'_'+String(d.code??d.error_code??'FAILED').replace(/[^a-zA-Z0-9_]/g,''));}
  await p.getByRole('heading',{name:'Check your email',exact:true}).waitFor();
  const user=(await pool.query('SELECT id FROM auth.users WHERE email=$1 AND NOT is_anonymous',[email])).rows[0];
  if(!user)throw new Error('REGISTRATION_ACCOUNT_MISSING');users.add(user.id);
  // Test-only email-verification fixture. Ordinary users click Supabase's email link.
  await pool.query("UPDATE auth.users SET email_confirmed_at=now(),confirmation_token='' WHERE id=$1",[user.id]);
  await login(p,email);return user.id;
 }
 const owner=await pageFor(),staff=await pageFor();
 stage='invalid-login';await owner.goto(origin+'/login');await owner.getByLabel('Email',{exact:true}).fill(api.TEST_STAFF_EMAIL);await owner.getByLabel('Password',{exact:true}).fill(password);await owner.getByLabel('Password',{exact:true}).press('Enter');await expect(owner.getByRole('alert')).toContainText('Unable to sign in');result.invalidCredentialsHandled=true;
 stage='owner-registration';await register(owner,ownerEmail,'Anna Wijaya');result[process.argv.includes('--fixture-accounts')?'ownerFixturePasswordLogin':'ownerRegisteredThroughSupabase']=true;
 await expect(owner.getByText(/Welcome to Qevra/)).toBeVisible();result.emptyMembershipOnboarding=true;
 stage='staff-registration';const staffId=await register(staff,staffEmail,'Sunter Staff');result[process.argv.includes('--fixture-accounts')?'staffFixturePasswordLogin':'staffRegisteredThroughSupabase']=true;
 await staff.getByRole('button',{name:'Sign out',exact:true}).click();await staff.waitForURL('**/login');await staff.reload();await staff.goto(origin+'/app');await staff.waitForURL('**/login');result.logoutSessionCleared=true;
 stage='owner-onboarding';await owner.getByRole('link',{name:'Create business',exact:true}).click();await owner.getByLabel('Business name',{exact:true}).fill('Salon Anna Wijaya');await owner.getByLabel('Business slug').fill('anna-'+tag);await owner.getByRole('button',{name:'Create business',exact:true}).click();await owner.getByRole('heading',{name:'Salon Anna Wijaya',exact:true}).waitFor();businessId=new URL(owner.url()).pathname.split('/')[2];
 await owner.getByRole('link',{name:'Branches & services',exact:true}).click();await owner.getByRole('button',{name:'Create branch',exact:true}).click();await owner.getByLabel('Branch name',{exact:true}).fill('Sunter');await owner.getByLabel('Public slug').fill('sunter-'+tag);await owner.getByRole('button',{name:'Create branch',exact:true}).click();await owner.getByRole('heading',{name:'Sunter',exact:true}).waitFor();branchId=new URL(owner.url()).pathname.split('/')[4];
 await owner.getByRole('button',{name:'Copy Link',exact:true}).click();await expect(owner.getByRole('status')).toContainText('Link copied.');const publicUrl=await owner.evaluate(()=>navigator.clipboard.readText());assert.equal(publicUrl,origin+'/q/sunter-'+tag);result.publicLinkUsesFrontendOrigin=true;
 await owner.getByRole('link',{name:'View services',exact:true}).click();await owner.getByRole('button',{name:'Create service',exact:true}).click();await owner.getByLabel('Service name',{exact:true}).fill('Potong Rambut');await owner.getByLabel('Price (IDR)').fill('80000');await owner.getByLabel('Queue prefix').fill('P');await owner.getByRole('button',{name:'Create service',exact:true}).click();await owner.getByRole('heading',{name:'Potong Rambut',exact:true}).waitFor();serviceId=new URL(owner.url()).pathname.split('/')[6];
 await owner.getByLabel('New counter name').fill('Stylist 1');await owner.getByRole('button',{name:'Add counter',exact:true}).click();await owner.getByLabel('Counter name',{exact:true}).waitFor();
 counterId=(await pool.query('SELECT id FROM public.service_counters WHERE service_id=$1',[serviceId])).rows[0].id;
 await owner.getByRole('link',{name:'Open queue',exact:true}).click();await owner.getByRole('button',{name:'Open queue',exact:true}).click();await owner.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();result.ownerCreatedBusinessBranchServiceCounterAndQueue=true;
 stage='team-email';await owner.getByRole('link',{name:'Team & access',exact:true}).click();await owner.getByLabel('Member email').fill('unknown-'+tag+'@example.test');await owner.getByRole('button',{name:'Add member',exact:true}).click();await expect(owner.getByRole('alert')).toContainText('No Qevra account was found');result.unknownEmailExplained=true;
 await owner.getByLabel('Member email').fill(staffEmail.toUpperCase());await owner.getByRole('button',{name:'Add member',exact:true}).click();await owner.getByRole('heading',{name:'Sunter Staff',exact:true}).waitFor();
 await owner.getByRole('checkbox',{name:'Sunter',exact:true}).check();await owner.getByRole('checkbox',{name:'Sunter · Potong Rambut',exact:true}).check();await owner.getByRole('button',{name:'Save assignments',exact:true}).click();await expect(owner.getByRole('button',{name:'Save assignments',exact:true})).toBeEnabled();
 assert.ok(!(await owner.locator('body').innerText()).includes(staffId));result.teamEmailAndAssignmentsWithoutUuid=true;
 stage='responsive';for(const width of [1440,768,390]){await owner.setViewportSize({width,height:900});assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}await owner.screenshot({path:'.runtime/phase8-team-mobile.png',fullPage:true,mask:[owner.locator('p.break-all')]});result.responsiveNoOverflow=true;await owner.setViewportSize({width:1440,height:1000});
 stage='staff-access';await login(staff,staffEmail);await staff.goto(origin+'/app/'+businessId);await expect(staff.getByRole('link',{name:'Analytics',exact:true})).toHaveCount(0);await expect(staff.getByRole('link',{name:'Team & access',exact:true})).toHaveCount(0);result.staffNavigationScoped=true;
 const queuePath='/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/queue';await staff.goto(origin+queuePath);await staff.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();
 const denial=await staff.evaluate(async businessId=>{const {request}=await import('/src/lib/configuration-api.ts');try{await request('/businesses/'+businessId+'/analytics');return 200;}catch(e){return e.status;}},businessId);assert.equal(denial,403);result.staffAnalyticsDenied=true;
 stage='anonymous-join';const customer=await pageFor(390);result.broadcasts=0;result.ticketSnapshots=[];customer.on('websocket',socket=>socket.on('framereceived',event=>{if(String(event.payload).includes('queue_changed'))result.broadcasts++;}));customer.on('response',async r=>{if(r.url().includes('/customer/tickets/')&&r.request().method()==='GET'){try{const d=await r.json();result.ticketSnapshots.push({status:r.status(),ticket:d.ticket?.status,revision:d.queue?.revision});}catch{/* diagnostics only */}}});await customer.goto(publicUrl);await customer.getByRole('link',{name:'Join queue',exact:true}).click();await customer.getByLabel('Your name',{exact:true}).fill('MVP Customer');await expect(customer.getByRole('button',{name:'Join queue',exact:true})).toBeEnabled();await customer.getByRole('button',{name:'Join queue',exact:true}).click();await customer.waitForURL('**/ticket/*');await expect(customer.getByTestId('queue-number')).toHaveText('P001');await customer.getByTestId('notification-QUEUE_JOINED').waitFor();await customer.getByText('Updates are live.',{exact:true}).waitFor();result.anonymousJoinAndNotification=true;
 stage='staff-lifecycle';await staff.getByRole('button',{name:'Refresh',exact:true}).click();await staff.getByRole('button',{name:'Call P001',exact:true}).waitFor();await staff.getByLabel('Available counter').selectOption(counterId);const calledResponse=staff.waitForResponse(r=>r.url().endsWith('/queue/call-next')&&r.request().method()==='POST');await staff.getByRole('button',{name:'Call next',exact:true}).click();const called=await calledResponse;if(!called.ok()){const body=await called.json();throw new Error('CALL_FAILED_'+called.status()+'_'+body.error?.code);}result.callOutcome=(await called.json()).outcome;result.databaseTicketState=(await pool.query('SELECT status FROM public.queue_tickets WHERE service_id=$1',[serviceId])).rows[0]?.status;await expect(customer.getByTestId('ticket-status')).toHaveText('CALLED',{timeout:80000});await customer.getByTestId('notification-YOUR_TURN').waitFor();
 await staff.getByRole('button',{name:'Start service',exact:true}).click();await expect(customer.getByTestId('ticket-status')).toHaveText('SERVING');await customer.getByTestId('notification-SERVICE_STARTED').waitFor();
 await staff.getByRole('button',{name:'Complete',exact:true}).click();await expect(customer.getByTestId('ticket-status')).toHaveText('COMPLETED');await customer.getByTestId('notification-SERVICE_COMPLETED').waitFor();assert.ok(result.broadcasts>0,'No committed realtime broadcast received');result.staffOperatesQueueWithRealtimeNotifications=true;
 stage='owner-analytics';await owner.goto(origin+'/app/'+businessId+'/analytics');await expect(owner.getByTestId('metric-customers-joined')).toHaveText('1');await expect(owner.getByTestId('metric-completed')).toHaveText('1');result.analyticsReflectsRealActivity=true;
 stage='mock-payment';await owner.goto(origin+'/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/settings');await owner.getByLabel('Payment mode').selectOption('FULL');await owner.getByRole('button',{name:'Save service',exact:true}).click();await owner.getByText('Changes saved.',{exact:true}).waitFor();
 const paid=await pageFor(390);await paid.goto(publicUrl);await paid.getByRole('link',{name:'Pay & join',exact:true}).click();await paid.getByLabel('Your name',{exact:true}).fill('MVP Paid Customer');await expect(paid.getByRole('button',{name:'Pay & join',exact:true})).toBeEnabled();await paid.getByRole('button',{name:'Pay & join',exact:true}).click();await paid.waitForURL('**/checkout/*');await paid.getByRole('heading',{name:'Development Mock Payment',exact:true}).waitFor();await paid.getByRole('button',{name:'Simulate Successful Payment',exact:true}).click();await paid.waitForURL('**/ticket/*');await expect(paid.getByTestId('queue-number')).toHaveText('P002');result.mockPaymentStillWorks=true;
 result.noUncaughtBrowserErrors=errors.length===0;
}catch(error){result.failureStage=stage;if(browser){result.alerts=[];for(const context of browser.contexts())for(const page of context.pages())result.alerts.push(await page.getByRole('alert').allTextContents().catch(()=>[]));}let message=String(error?.message??'');for(const value of [...Object.values(api),...Object.values(web),ownerEmail,staffEmail,password].filter(v=>v.length>5))message=message.split(value).join('[redacted]');result.failureDetail=message.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token]').slice(0,1600);process.exitCode=1;
}finally{
 clearInterval(progress);await browser?.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}vite?.kill();for(let i=0;active&&i<120;i++)await delay(250);
 if(pool){try{await run(async c=>{
  for(const r of (await c.query('SELECT id FROM auth.users WHERE email=ANY($1::text[])',[[ownerEmail,staffEmail]])).rows)users.add(r.id);
  if(!businessId&&users.size)businessId=(await c.query("SELECT id FROM public.businesses WHERE slug=$1 AND created_by=ANY($2::uuid[])",['anna-'+tag,[...users]])).rows[0]?.id;
  if(businessId){for(const r of (await c.query('SELECT DISTINCT customer_auth_id FROM public.join_requests WHERE business_id=$1',[businessId])).rows)users.add(r.customer_auth_id);
   for(const table of ['queue_command_keys','queue_events','queue_tickets','payment_events','payments','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])await c.query('DELETE FROM public.'+table+' WHERE business_id=$1',[businessId]);
   await c.query('DELETE FROM public.businesses WHERE id=$1',[businessId]);
  }
  if(users.size){await c.query('DELETE FROM public.profiles WHERE user_id=ANY($1::uuid[])',[[...users]]);await c.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[...users]]);}
 });result.fixturesCleaned=true;}catch{result.fixturesCleaned=false;process.exitCode=1;}await pool.end();}
 const secrets=[...Object.entries(api),...Object.entries(web)].filter(([k,v])=>/KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(k)&&v.length>5).map(([,v])=>v);secrets.push(password,ownerEmail,staffEmail);try{secrets.push(decodeURIComponent(new URL(api.DATABASE_URL).password));}catch{/* No credentials printed. */}
 result.noCredentialsInLogs=!secrets.some(v=>logs.join('').includes(v))&&!/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(logs.join(''));if(Object.values(result).some(v=>v===false))process.exitCode=1;
 writeFileSync('.runtime/phase8-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
