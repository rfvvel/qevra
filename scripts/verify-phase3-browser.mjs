import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from '@playwright/test';

const api = parse(readFileSync('apps/api/.env')), web = parse(readFileSync('apps/web/.env'));
Object.assign(process.env, api, { PORT: '3103', WEB_ORIGIN: 'http://localhost:5175' });
const logs = [], result = {};
let browser, server, vite, pool, client;
let stage = 'setup';
let serial = Promise.resolve();
const tag = 'browser-' + randomUUID();
try {
  if (!api.TEST_STAFF_EMAIL || !api.TEST_STAFF_PASSWORD) throw new Error('MISSING_TEST_CREDENTIALS');
  const { createApp } = await import('../apps/api/src/app.ts');
  pool = new pg.Pool({ connectionString: api.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  client = await pool.connect();
  await client.query('BEGIN');
  // Real production routes, real JWT verification and real PostgreSQL. Savepoints
  // isolate HTTP operations while the outer transaction prevents test data leakage.
  const run = operation => {
    const job = serial.then(async () => {
      await client.query('SAVEPOINT browser_operation');
      try { const value = await operation(client); await client.query('RELEASE SAVEPOINT browser_operation'); return value; }
      catch (error) { await client.query('ROLLBACK TO SAVEPOINT browser_operation'); await client.query('RELEASE SAVEPOINT browser_operation'); throw error; }
    });
    serial = job.catch(() => {});
    return job;
  };
  server = createApp({ runTransaction: run }).listen(3103);
  await once(server, 'listening');
  vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', 'localhost', '--port', '5175', '--strictPort'], { cwd: resolve('apps/web'), env: { ...process.env, VITE_API_URL: 'http://localhost:3103/api/v1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  vite.stdout.on('data', chunk => logs.push(chunk.toString()));
  vite.stderr.on('data', chunk => logs.push(chunk.toString()));
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://localhost:5175', { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* wait for Vite */ }
    await delay(250);
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => { logs.push(error.message); errors.push('page-error'); });
  stage = 'protected-login';
  await page.goto('http://localhost:5175/app');
  await page.waitForURL('**/login');
  await page.getByLabel('Email', { exact: true }).fill(api.TEST_STAFF_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(api.TEST_STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Your businesses' }).waitFor();
  result.authenticatedDashboard = true;
  stage='queue-fixture';
  const {admitJoinRequest}=await import('../apps/api/src/modules/queues/admission.ts');
  const owner=(await client.query('SELECT id FROM auth.users WHERE email=$1',[api.TEST_STAFF_EMAIL])).rows[0].id;
  const businessId=randomUUID(),branchId=randomUUID(),serviceId=randomUUID(),counterId=randomUUID();
  await client.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Queue browser staff') ON CONFLICT DO NOTHING",[owner]);
  await client.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Queue browser demo',$2,$3)",[businessId,tag,owner]);
  await client.query("INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,'OWNER')",[businessId,owner]);
  await client.query("INSERT INTO public.branches(id,business_id,name,public_slug) VALUES($1,$2,'Central Park',$3)",[branchId,businessId,tag+'-branch']);
  await client.query("INSERT INTO public.services(id,business_id,branch_id,name,queue_prefix,price_amount,estimated_duration_minutes,payment_mode) VALUES($1,$2,$3,'Haircut','H',80000,30,'NONE')",[serviceId,businessId,branchId]);
  await client.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,'Stylist 1')",[counterId,businessId,branchId,serviceId]);
  const queueUrl='http://localhost:5175/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/queue';
  await page.goto(queueUrl);
  await page.getByRole('button',{name:'Open queue',exact:true}).click();
  await page.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();
  result.openQueue=true;
  await run(async c=>{
    const session=(await c.query('SELECT id FROM public.queue_sessions WHERE service_id=$1',[serviceId])).rows[0].id;
    for(let i=1;i<=3;i++){
      const customer=randomUUID();
      await c.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,true)',[customer]);
      const req=(await c.query(`INSERT INTO public.join_requests(business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,status,payment_mode_snapshot,price_snapshot,amount_due,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'READY','NONE',80000,0,clock_timestamp()+interval '1 hour') RETURNING id`,[businessId,branchId,serviceId,session,customer,'Demo customer '+i])).rows[0];
      await admitJoinRequest(c,{businessId,branchId,serviceId},{userId:owner,type:'STAFF'},req.id);
    }
  });
  stage='call-start-complete';
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('button',{name:'Call H001',exact:true}).waitFor();
  await page.getByLabel('Available counter').selectOption(counterId);
  await page.getByRole('button',{name:'Call next',exact:true}).click();
  await page.getByRole('button',{name:'Start service',exact:true}).click();
  await page.getByRole('button',{name:'Complete',exact:true}).click();
  await page.getByText('1 completed today',{exact:false}).waitFor();
  result.callStartComplete=true;
  stage='skip-requeue';
  await page.getByRole('button',{name:'Call next',exact:true}).click();
  await page.getByRole('button',{name:'Skip',exact:true}).click();
  await page.getByRole('button',{name:'Requeue',exact:true}).click();
  await page.getByRole('button',{name:'Call H002',exact:true}).waitFor();
  result.skipRequeue=true;
  stage='manual-call-reason';
  await page.getByRole('button',{name:'Call H002',exact:true}).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Reason for calling out of order').fill('Development priority test');
  await page.getByRole('button',{name:'Call H002',exact:true}).click();
  await page.getByRole('button',{name:'No show',exact:true}).click();
  await page.getByRole('button',{name:'Call H003',exact:true}).waitFor();
  result.manualCallAndNoShow=true;
  stage='pause-resume';
  await page.getByRole('button',{name:'Pause queue',exact:true}).click();
  await page.getByRole('heading',{name:'Queue: PAUSED',exact:true}).waitFor();
  if(!await page.getByRole('button',{name:'Call next',exact:true}).isDisabled())throw new Error('PAUSED_CALL_ENABLED');
  await page.getByRole('button',{name:'Resume queue',exact:true}).click();
  await page.getByRole('heading',{name:'Queue: OPEN',exact:true}).waitFor();
  result.pauseResume=true;
  await page.reload();
  await page.getByRole('button',{name:'Call H003',exact:true}).waitFor();
  result.queuePersistsAfterRefresh=true;
  mkdirSync('.runtime',{recursive:true});
  await page.screenshot({path:'.runtime/phase3-queue-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  result.mobileNoOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  await page.screenshot({path:'.runtime/phase3-queue-mobile.png',fullPage:true});
  stage='cancel-close';
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Close queue',exact:true}).click();
  await page.getByRole('heading',{name:'Queue: CLOSED',exact:true}).waitFor();
  result.cancelClose=true;
  result.noUncaughtBrowserErrors=errors.length===0;
  if(Object.values(result).some(value=>value===false))throw new Error('BROWSER_ASSERTION');
  await context.close();
} catch (error) {
  result.failureCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'BROWSER_CHECK_FAILED';
  result.failureStage = stage;
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (vite) vite.kill();
  await serial;
  if (client) { await client.query('ROLLBACK'); client.release(); result.fixturesRolledBack = true; }
  await pool?.end();
  const secrets = [...Object.entries(api), ...Object.entries(web)].filter(([key, value]) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(key) && value.length > 5).map(([,value]) => value);
  try { secrets.push(decodeURIComponent(new URL(api.DATABASE_URL).password)); } catch { /* never log URL */ }
  const text = logs.join('');
  result.noCredentialsInLogs = !secrets.some(secret => text.includes(secret)) && !/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text);
  if (!result.noCredentialsInLogs) process.exitCode = 1;
  mkdirSync('.runtime', { recursive: true });
  writeFileSync('.runtime/phase3-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
