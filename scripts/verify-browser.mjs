import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { chromium } from '@playwright/test';

const api = parse(readFileSync('apps/api/.env'));
const web = parse(readFileSync('apps/web/.env'));
const apiBase = `http://localhost:${api.PORT || 3001}`;
const webBase = 'http://localhost:5173';
const children = [];
const capturedLogs = [];
const result = {};
let browser;
let stage = 'startup';
function start(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', chunk => capturedLogs.push(chunk.toString()));
  child.stderr.on('data', chunk => capturedLogs.push(chunk.toString()));
  children.push(child);
}
async function reachable(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await reachable(url)) return;
    await delay(500);
  }
  throw new Error('SERVER_NOT_READY');
}
async function expectText(page, id, expected) {
  await page.getByTestId(id).filter({ hasText: expected }).waitFor({ timeout: 25000 });
  if (await page.getByTestId(id).textContent() !== expected) throw new Error('CHECK_FAILED');
}
function listen(page) {
  page.on('console', message => capturedLogs.push(message.text()));
  page.on('pageerror', error => capturedLogs.push(error.message));
}
try {
  if (!await reachable(`${apiBase}/api/v1/health`)) start(['dist/server.js'], resolve('apps/api'));
  if (!await reachable(webBase)) start([resolve('node_modules/vite/bin/vite.js'), '--host', 'localhost'], resolve('apps/web'));
  await waitFor(`${apiBase}/api/v1/health`);
  await waitFor(webBase);
  stage = 'browser-launch';
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const staffOnly = process.argv.includes('--staff-only');
  if (!staffOnly) {
    stage = 'anonymous-browser-flow';
    const context = await browser.newContext();
    const page = await context.newPage();
    listen(page);
    let signups = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/auth/v1/signup')) signups++; });
    await page.goto(`${webBase}/__verify`);
    await expectText(page, 'api', 'Passed');
    await expectText(page, 'database', 'Passed');
    result.reactExpressPostgres = 'passed';
    await expectText(page, 'anonymous', 'Passed');
    await expectText(page, 'server-auth', 'Passed');
    result.browserAnonymousAuth = 'passed';
    result.expressRealTokenVerification = 'passed';
    result.customerHasNoLoginForm = await page.locator('input').count() === 0;
    const originalUser = await page.evaluate(() => {
      const entry = Object.entries(localStorage).find(([key]) => key.startsWith('sb-') && key.endsWith('-auth-token'));
      return entry ? JSON.parse(entry[1]).user.id : null;
    });
    const initialSignups = signups;
    stage = 'refresh-persistence';
    await page.reload();
    await expectText(page, 'anonymous', 'Passed');
    await expectText(page, 'persistence', 'Restored');
    await expectText(page, 'server-auth', 'Passed');
    const restoredUser = await page.evaluate(() => {
      const entry = Object.entries(localStorage).find(([key]) => key.startsWith('sb-') && key.endsWith('-auth-token'));
      return entry ? JSON.parse(entry[1]).user.id : null;
    });
    result.sameAnonymousUserAfterRefresh = Boolean(originalUser && originalUser === restoredUser);
    result.noAdditionalSignupAfterRefresh = signups === initialSignups;
    result.singleAnonymousSignup = initialSignups === 1;
    if (!result.sameAnonymousUserAfterRefresh || !result.noAdditionalSignupAfterRefresh || !result.singleAnonymousSignup) throw new Error('PERSISTENCE_FAILED');
    const staffRejected = await page.evaluate(async () => {
      const entry = Object.entries(localStorage).find(([key]) => key.startsWith('sb-') && key.endsWith('-auth-token'));
      if (!entry) return false;
      const response = await fetch('/api/v1/auth/staff', { headers: { Authorization: 'Bearer ' + JSON.parse(entry[1]).access_token } });
      return response.status === 403;
    });
    result.anonymousRejectedByStaffGuard = staffRejected;
    if (!staffRejected) throw new Error('GUARD_FAILED');
    await context.close();
  }
  stage = 'staff-browser-flow';
  if (api.TEST_STAFF_EMAIL && api.TEST_STAFF_PASSWORD) {
    const context = await browser.newContext();
    const page = await context.newPage();
    listen(page);
    await page.goto(`${webBase}/__verify?staff=1`);
    await page.getByLabel('Test staff email').fill(api.TEST_STAFF_EMAIL);
    await page.getByLabel('Test staff password').fill(api.TEST_STAFF_PASSWORD);
    await page.getByRole('button', { name: 'Verify staff authentication' }).click();
    await page.waitForFunction(() => ['Passed', 'Failed'].includes(document.querySelector('[data-testid=staff]')?.textContent ?? ''), undefined, { timeout: 25000 });
    if (await page.getByTestId('staff').textContent() !== 'Passed') throw new Error('STAFF_LOGIN_FAILED');
    result.staffPasswordLoginAndExpressVerification = 'passed';
    // Remove this test's refresh session without printing or persisting its tokens.
    await page.evaluate(async () => {
      const { getSupabase } = await import('/src/lib/supabase.ts');
      await getSupabase().auth.signOut({ scope: 'local' });
    });
    await context.close();
  } else { result.staffPasswordLoginAndExpressVerification = 'pending-test-credentials'; process.exitCode = 1; }
} catch {
  result.failureStage = stage;
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const child of children) child.kill();
  const secretValues = [...Object.entries(api), ...Object.entries(web)]
    .filter(([key, value]) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|TEST_STAFF_EMAIL/.test(key) && value.length > 5)
    .map(([, value]) => value);
  try { secretValues.push(decodeURIComponent(new URL(api.DATABASE_URL).password)); } catch { /* no URL output */ }
  const logText = capturedLogs.join('');
  result.noCredentialsInCapturedLogs = !secretValues.filter(Boolean).some(value => logText.includes(value)) && !/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(logText);
  if (!result.noCredentialsInCapturedLogs) process.exitCode = 1;
  mkdirSync('.runtime', { recursive: true });
  writeFileSync(process.argv.includes('--staff-only') ? '.runtime/staff-verification.json' : '.runtime/browser-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
