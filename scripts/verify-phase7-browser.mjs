import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parse} from 'dotenv';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import {chromium,expect as baseExpect} from '@playwright/test';
import {analyticsFixture} from '../tests/helpers/analytics-fixture.ts';
const api=parse(readFileSync('apps/api/.env')),web=parse(readFileSync('apps/web/.env'));
Object.assign(process.env,api,{NODE_ENV:'development',PORT:'3107',WEB_ORIGIN:'http://localhost:5179'});
const expect=baseExpect.configure({timeout:30000});
const origin='http://localhost:5179',result={},logs=[],errors=[];
let browser,server,vite,pool,fixture,stage='setup',active=0;
async function transaction(op){active++;let c;try{c=await pool.connect();await c.query('BEGIN');const v=await op(c);await c.query('COMMIT');return v;}catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();active--;}}
try{
 const {createApp}=await import('../apps/api/src/app.ts');
 pool=new pg.Pool({connectionString:api.DATABASE_URL,max:6,connectionTimeoutMillis:15000});
 const owner=(await pool.query('SELECT id FROM auth.users WHERE email=$1 AND email_confirmed_at IS NOT NULL',[api.TEST_STAFF_EMAIL])).rows[0]?.id;
 if(!owner)throw new Error('MISSING_STAFF');fixture=analyticsFixture(owner);await transaction(fixture.seed);
 server=createApp({runTransaction:transaction}).listen(3107);await once(server,'listening');
 vite=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','localhost','--port','5179','--strictPort'],{cwd:resolve('apps/web'),env:{...process.env,VITE_API_URL:'http://localhost:3107/api/v1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 vite.stdout.on('data',c=>logs.push(c.toString()));vite.stderr.on('data',c=>logs.push(c.toString()));
 for(let i=0;i<60;i++){try{if((await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok)break;}catch{/* Startup wait. */}await delay(250);}
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
 page.on('console',m=>logs.push(m.text()));page.on('pageerror',()=>errors.push('page-error'));
 stage='login';await page.goto(origin+'/app');await page.waitForURL('**/login');await page.getByLabel('Email',{exact:true}).fill(api.TEST_STAFF_EMAIL);await page.getByLabel('Password',{exact:true}).fill(api.TEST_STAFF_PASSWORD);await page.getByLabel('Password',{exact:true}).press('Enter');await page.getByRole('heading',{name:'Your businesses',exact:true}).waitFor();
 stage='dashboard';await page.goto(origin+'/app/'+fixture.business);await page.getByRole('link',{name:'Analytics',exact:true}).click();
 await expect(page.getByTestId('metric-customers-joined')).toHaveText('1');await expect(page.getByTestId('live-waiting')).toHaveText('1');result.todayAndLive=true;
 await page.getByLabel('Date range',{exact:true}).selectOption('LAST_7_DAYS');
 await expect(page.getByTestId('metric-customers-joined')).toHaveText('11');await expect(page.getByTestId('metric-completed')).toHaveText('5');
 await expect(page.getByTestId('metric-average-wait')).toHaveText('15.6 min');await expect(page.getByTestId('metric-average-service-time')).toHaveText('30 min');
 await expect(page.getByTestId('metric-cancelled')).toHaveText('1');await expect(page.getByTestId('metric-no-show')).toHaveText('1');result.summaryMatchesStoredHistory=true;
 await expect(page.getByTestId('busiest-hour')).toContainText('09:00–10:00');await expect(page.getByTestId('busiest-hour')).toContainText('3 customers joined');
 const volume=page.getByRole('list',{name:'Hourly admissions'});await expect(volume.getByRole('listitem')).toHaveCount(24);await expect(volume.getByLabel('09:00: 3 admitted',{exact:true})).toBeVisible();result.hourlyVolumeAndBusiestHour=true;
 const serviceTable=page.getByRole('table',{name:'Service performance'});await expect(serviceTable.getByRole('row').filter({hasText:'Haircut'}).locator('th,td')).toHaveText(['Haircut','9','3','15.8 min','30 min','1','1']);await expect(serviceTable.getByRole('row').filter({hasText:'Hair Coloring'}).locator('th,td')).toHaveText(['Hair Coloring','1','1','5 min','10 min','0','0']);
 await expect(page.getByRole('table',{name:'Branch performance'}).getByRole('row').filter({hasText:'Central'})).toContainText('10');result.serviceAndBranchTables=true;
 mkdirSync('.runtime',{recursive:true});await page.screenshot({path:'.runtime/phase7-desktop.png',fullPage:true});
 stage='filters';await page.getByLabel('Date range',{exact:true}).selectOption('LAST_30_DAYS');await expect(page.getByTestId('metric-customers-joined')).toHaveText('12');await expect(page.getByTestId('live-waiting')).toHaveText('1');result.monthAndLiveSeparation=true;
 await page.getByLabel('Branch',{exact:true}).selectOption(fixture.branches[1]);await expect(page.getByTestId('metric-customers-joined')).toHaveText('1');
 await expect(page.getByLabel('Service',{exact:true}).getByRole('option')).toHaveCount(3);result.branchFilter=true;
 await page.getByLabel('Service',{exact:true}).selectOption(fixture.services[3]);await page.getByRole('heading',{name:'No results for selected filters'}).waitFor();await expect(page.getByRole('list',{name:'Hourly admissions'})).toHaveCount(0);result.emptyFilter=true;
 await page.getByLabel('Branch',{exact:true}).selectOption('');await page.getByLabel('Date range',{exact:true}).selectOption('LAST_7_DAYS');await expect(page.getByTestId('metric-customers-joined')).toHaveText('11');
 stage='responsive';for(const width of [768,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));}await page.screenshot({path:'.runtime/phase7-mobile.png',fullPage:true});result.tabletMobileNoOverflow=true;
 stage='error-state';await page.route('**/analytics?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Analytics temporarily unavailable.'}})}));await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('alert').filter({hasText:'Analytics temporarily unavailable.'}).waitFor();await expect(page.getByTestId('metric-customers-joined')).toHaveCount(0);result.errorHidesStaleMetrics=true;await page.unroute('**/analytics?**');await page.getByRole('button',{name:'Try again'}).click();await expect(page.getByTestId('metric-customers-joined')).toHaveText('11');
 stage='role-revocation';await pool.query("UPDATE public.business_members SET role='STAFF' WHERE business_id=$1 AND user_id=$2",[fixture.business,owner]);await page.reload();await page.getByRole('alert').filter({hasText:'Analytics are available to owners'}).waitFor();await expect(page.getByRole('link',{name:'Analytics',exact:true})).toHaveCount(0);result.staffUnauthorizedState=true;
 result.noUncaughtBrowserErrors=errors.length===0;
}catch(error){
 result.failureStage=stage;result.errorKind=error?.name;if(browser){result.alerts=[];for(const context of browser.contexts())for(const p of context.pages())result.alerts.push(await p.getByRole('alert').allTextContents().catch(()=>[]));}let detail=String(error?.message??'');
 for(const value of [...Object.values(api),...Object.values(web)].filter(v=>v.length>5))detail=detail.split(value).join('[redacted]');
 result.failureDetail=detail.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token]').slice(0,1600);process.exitCode=1;
}finally{
 await browser?.close().catch(()=>{});if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}vite?.kill();
 for(let i=0;active&&i<120;i++)await delay(250);
 if(pool){try{if(fixture)await transaction(fixture.cleanup);result.fixturesCleaned=true;}catch{result.fixturesCleaned=false;process.exitCode=1;}await pool.end();}
 const secrets=[...Object.entries(api),...Object.entries(web)].filter(([k,v])=>/KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(k)&&v.length>5).map(([,v])=>v);
 try{secrets.push(decodeURIComponent(new URL(api.DATABASE_URL).password));}catch{/* No credentials logged. */}
 result.noCredentialsInLogs=!secrets.some(s=>logs.join('').includes(s))&&!/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(logs.join(''));
 if(Object.values(result).some(v=>v===false))process.exitCode=1;
 mkdirSync('.runtime',{recursive:true});writeFileSync('.runtime/phase7-browser.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
