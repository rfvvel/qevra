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
Object.assign(process.env, api,{PORT:'3102',WEB_ORIGIN:'http://localhost:5174'});
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
  server = createApp({ runTransaction: run }).listen(3102);
  await once(server, 'listening');
  vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', 'localhost','--port','5174','--strictPort'], { cwd: resolve('apps/web'), env:{...process.env,VITE_API_URL:'http://localhost:3102/api/v1'}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  vite.stdout.on('data', chunk => logs.push(chunk.toString()));
  vite.stderr.on('data', chunk => logs.push(chunk.toString()));
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://localhost:5174', { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* wait for Vite */ }
    await delay(250);
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('dialog',dialog=>dialog.accept());
  const errors = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => { logs.push(error.message); errors.push('page-error'); });
  stage = 'protected-login';
  await page.goto('http://localhost:5174/app');
  await page.waitForURL('**/login');
  await page.getByLabel('Email', { exact: true }).fill(api.TEST_STAFF_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(api.TEST_STAFF_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Your businesses' }).waitFor();
  result.authenticatedDashboard = true;
  stage = 'create-business';
  await page.getByRole('link', { name: 'Create business', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Qevra Browser Test');
  await page.getByLabel('Business slug').fill(tag);
  await page.getByRole('button', { name: 'Create business', exact: true }).click();
  await page.getByRole('heading', { name: 'Qevra Browser Test', exact: true }).waitFor();
  const businessId = new URL(page.url()).pathname.split('/')[2];
  result.businessCreation = true;
  stage = 'create-branch';
  await page.getByRole('link', { name: 'Branches & services', exact: true }).click();
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByLabel('Branch name', { exact: true }).fill('Central Park');
  await page.getByLabel('Public slug').fill(tag + '-branch');
  await page.getByLabel('Address', { exact: true }).fill('Development test address');
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByRole('heading', { name: 'Central Park', exact: true }).waitFor();
  const branchId = new URL(page.url()).pathname.split('/')[4];
  result.branchCreation = true;
  stage = 'create-service';
  await page.getByRole('link', { name: 'View services', exact: true }).click();
  await page.getByRole('button', { name: 'Create service', exact: true }).click();
  await page.getByLabel('Service name', { exact: true }).fill('Haircut');
  await page.getByLabel('Price (IDR)').fill('80000');
  await page.getByLabel('Queue prefix').fill('A');
  await page.getByRole('button', { name: 'Create service', exact: true }).click();
  await page.getByRole('heading', { name: 'Haircut', exact: true }).waitFor();
  const serviceId = new URL(page.url()).pathname.split('/')[6];
  result.serviceCreation = true;
  stage = 'payment-configuration';
  await page.getByLabel('Payment mode').selectOption('DEPOSIT');
  await page.getByLabel('Deposit (IDR)').fill('90000');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Deposit (IDR)').fill('10000');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/services/' + serviceId) && response.status() === 200);
  await page.getByRole('heading', { name: 'Haircut', exact: true }).waitFor();
  result.paymentConfigValidation = true;
  stage = 'counters';
  await page.getByLabel('New counter name').fill('Stylist station 1');
  await page.getByRole('button', { name: 'Add counter', exact: true }).click();
  await page.getByLabel('Counter name', { exact: true }).waitFor();
  await page.getByLabel('Counter name', { exact: true }).fill('Main stylist');
  await page.getByRole('checkbox', { name: 'Active', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save counter', exact: true }).click();
  await page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/counters') && response.status() === 200);
  result.counterConfiguration = true;
  stage = 'staff-management';
  // A synthetic confirmed identity is used only inside this rolled-back DB
  // transaction; the browser actor remains a real, authenticated Supabase user.
  const testMember = randomUUID();
  await client.query('INSERT INTO auth.users(id, is_anonymous, email_confirmed_at,email) VALUES ($1,false,now(),$2)', [testMember,testMember+'@example.test']);
  await page.getByRole('link', { name: 'Team & access', exact: true }).click();
  await page.getByLabel('Member email').fill(testMember+'@example.test');
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page.getByRole('button', { name: 'Save assignments', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Central Park', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Central Park · Haircut', exact: true }).check();
  await page.getByRole('button', { name: 'Save assignments', exact: true }).click();
  await page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/members') && response.status() === 200);
  result.staffAssignment = true;
  await page.reload();
  await page.getByRole('heading', { name: 'Team & access', exact: true }).waitFor();
  result.staffSessionAfterReload = true;
  stage = 'public-catalog';
  const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const publicPage = await publicContext.newPage();
  let anonymousSignups = 0;
  publicPage.on('request', request => { if (new URL(request.url()).pathname.endsWith('/auth/v1/signup')) anonymousSignups++; });
  await publicPage.goto('http://localhost:5174/q/' + tag + '-branch');
  await publicPage.getByRole('heading', { name: 'Central Park', exact: true }).waitFor();
  await publicPage.getByRole('heading', { name: 'Haircut', exact: true }).waitFor();
  result.publicCatalogWithoutLogin = true;
  result.publicBrowseDoesNotCreateAuthAccount = anonymousSignups === 0;
  result.mobilePublicNoHorizontalOverflow = await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.setViewportSize({ width: 390, height: 844 });
  result.mobileDashboardNoHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  mkdirSync('.runtime', { recursive: true });
  await publicPage.screenshot({ path: '.runtime/phase2-public-mobile.png', fullPage: true });
  await page.goto('http://localhost:5174/app/' + businessId + '/branches/' + branchId + '/services/' + serviceId + '/settings');
  await page.getByRole('heading', { name: 'Haircut', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Counter name', { exact: true }).waitFor();
  if (await page.getByLabel('Counter name', { exact: true }).inputValue() !== 'Main stylist' || await page.getByRole('checkbox', { name: 'Active', exact: true }).isChecked()) throw new Error('COUNTER_NOT_PERSISTED');
  result.counterChangesPersistAfterNavigation = true;
  await page.screenshot({ path: '.runtime/phase2-service-desktop.png', fullPage: true });
  result.noUncaughtBrowserErrors = errors.length === 0;
  if (Object.values(result).some(value => value === false)) throw new Error('BROWSER_ASSERTION');
  stage = 'signout';
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('**/login');
  result.signout = true;
  await publicContext.close();
  await context.close();
} catch {
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
  writeFileSync('.runtime/phase2-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
