import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { BusinessRole } from '@qevra/contracts';

// Deliberately fake credentials: tests intercept Auth and DB calls locally.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-public-key';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
const { createApp } = await import('../apps/api/src/app.js');
const { requireAuth, requireStaff } = await import('../apps/api/src/middleware/authentication.js');
const { requireBusinessRole } = await import('../apps/api/src/middleware/authorization.js');
const { errorHandler } = await import('../apps/api/src/middleware/error-handler.js');
const { getSupabaseAuth } = await import('../apps/api/src/config/supabase.js');
const { getPool, closePool } = await import('../apps/api/src/db/client.js');
const { default: express } = await import('express');

const app = createApp();
const protectedApp = express();
protectedApp.get('/businesses/:businessId', requireAuth, requireStaff, requireBusinessRole([BusinessRole.OWNER]), (_req, res) => res.json({ allowed: true }));
protectedApp.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
const protectedServer = protectedApp.listen(0, '127.0.0.1');
await Promise.all([once(server, 'listening'), once(protectedServer, 'listening')]);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const protectedBase = `http://127.0.0.1:${(protectedServer.address() as AddressInfo).port}`;
const businessId = '00000000-0000-4000-8000-000000000001';

after(async () => {
  server.closeAllConnections();
  protectedServer.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => protectedServer.close(() => resolve()))]);
  await closePool();
});

test('health returns the shared response without external services', async () => {
  const response = await fetch(`${base}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'qevra-api' });
});

test('business endpoints require authentication', async () => {
  assert.equal((await fetch(`${base}/api/v1/businesses`)).status, 401);
});

test('malformed JSON returns a sanitized 400', async () => {
  const response = await fetch(`${base}/missing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_JSON', message: 'Invalid JSON request body.' } });
});

test('staff authorization fails closed and checks current membership', async t => {
  const endpoint = `${protectedBase}/businesses/${businessId}`;
  const headers = { Authorization: 'Bearer fake-token' };
  await t.test('missing token is rejected', async () => {
    assert.equal((await fetch(endpoint)).status, 401);
  });
  await t.test('unverified token is rejected', async () => {
    const stub = mock.method(getSupabaseAuth().auth, 'getUser', async () => ({ data: { user: null }, error: new Error('invalid') }));
    try { assert.equal((await fetch(endpoint, { headers })).status, 401); } finally { stub.mock.restore(); }
  });
  await t.test('anonymous users cannot access business operations', async () => {
    const stub = mock.method(getSupabaseAuth().auth, 'getUser', async () => ({ data: { user: { id: businessId, is_anonymous: true } }, error: null }));
    try { assert.equal((await fetch(endpoint, { headers })).status, 403); } finally { stub.mock.restore(); }
  });
  const authStub = mock.method(getSupabaseAuth().auth, 'getUser', async () => ({ data: { user: { id: businessId, is_anonymous: false } }, error: null }));
  try {
    for (const [name, rows, status] of [
      ['non-member', [], 403],
      ['insufficient role', [{ id: businessId, role: BusinessRole.STAFF }], 403],
      ['authorized owner', [{ id: businessId, role: BusinessRole.OWNER }], 200],
    ] as const) {
      await t.test(name, async () => {
        const queryStub = mock.method(getPool(), 'query', async (_sql: string, values: unknown[]) => {
          assert.deepEqual(values, [businessId, businessId]);
          return { rows };
        });
        try { assert.equal((await fetch(endpoint, { headers })).status, status); } finally { queryStub.mock.restore(); }
      });
    }
  } finally { authStub.mock.restore(); }
});

test('database health reports connectivity without exposing query results', async () => {
  const stub = mock.method(getPool(), 'query', async () => ({ rows: [{ private: 'never-return-this' }] }));
  try {
    const response = await fetch(`${base}/api/v1/health/database`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
  } finally { stub.mock.restore(); }
});

test('database failures are sanitized and return 503', async () => {
  const logs: string[] = [];
  const logger = mock.method(console, 'error', (line: string) => { logs.push(line); });
  const stub = mock.method(getPool(), 'query', async () => { throw Object.assign(new Error('sensitive-driver-detail'), {code:'ERR_TLS_CERT_ALTNAME_INVALID'}); });
  try {
    const response = await fetch(`${base}/api/v1/health/database`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'error', database: 'unavailable' });
    assert.deepEqual(logs.map(line => JSON.parse(line)), [{
      event:'database_operation_failed', source:'health', category:'tls_hostname', code:'ERR_TLS_CERT_ALTNAME_INVALID',
    }]);
  } finally { stub.mock.restore(); logger.mock.restore(); }
});

test('session verification requires a bearer token', async () => {
  const response = await fetch(`${base}/api/v1/auth/session`);
  assert.equal(response.status, 401);
});

test('real auth routes distinguish guest sessions from staff identities', async () => {
  const stub = mock.method(getSupabaseAuth().auth, 'getUser', async () => ({ data: { user: { id: businessId, is_anonymous: true } }, error: null }));
  try {
    const headers = { Authorization: 'Bearer fake-token' };
    const response = await fetch(`${base}/api/v1/auth/session`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: true, isAnonymous: true });
    assert.equal((await fetch(`${base}/api/v1/auth/staff`, { headers })).status, 403);
  } finally { stub.mock.restore(); }
});
