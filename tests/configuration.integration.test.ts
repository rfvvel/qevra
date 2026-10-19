import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import type { BusinessDto, BranchDto, ServiceDto, MemberDto, CounterDto } from '@qevra/contracts';

test('Phase 2 HTTP operations enforce configuration integrity on PostgreSQL', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  // Only token verification is mocked here. Express validation/authorization,
  // repositories, SQL and constraints are real. Everything rolls back at the end.
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-public-key';
  const { createApp } = await import('../apps/api/src/app.js');
  const { getSupabaseAuth } = await import('../apps/api/src/config/supabase.js');
  const { closePool } = await import('../apps/api/src/db/client.js');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  await client.query('BEGIN');
  const owner = randomUUID(), outsider = randomUUID(), manager = randomUUID(), staff = randomUUID(), newcomer = randomUUID(), guest = randomUUID();
  const userIds = [owner, outsider, manager, staff, newcomer, guest];
  for (const user of userIds) await client.query('INSERT INTO auth.users(id, is_anonymous, email_confirmed_at) VALUES ($1,$2,now())', [user, user === guest]);
  const auth = mock.method(getSupabaseAuth().auth, 'getUser', async (token: string) =>
    userIds.includes(token) ? { data: { user: { id: token, is_anonymous: token === guest } }, error: null } : { data: { user: null }, error: new Error('Invalid') });
  let serial: Promise<unknown> = Promise.resolve();
  async function run<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const job = serial.then(async () => {
      await client.query('SAVEPOINT http_operation');
      try { const result = await operation(client); await client.query('RELEASE SAVEPOINT http_operation'); return result; }
      catch (error) { await client.query('ROLLBACK TO SAVEPOINT http_operation'); await client.query('RELEASE SAVEPOINT http_operation'); throw error; }
    });
    serial = job.catch(() => {});
    return job;
  }
  const server = createApp({ runTransaction: run }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
  async function call<T>(user: string | null, path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const response = await fetch(base + path, { method, headers: { ...(user ? { Authorization: 'Bearer ' + user } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, status, method + ' ' + path);
    return await response.json() as T;
  }
  const tag = 'test-' + randomUUID();
  let a: BusinessDto, b: BusinessDto, branchA: BranchDto, branchB: BranchDto, otherBranch: BranchDto, serviceX: ServiceDto, serviceY: ServiceDto, counter: CounterDto;
  let ownerMember: MemberDto, managerMember: MemberDto, staffMember: MemberDto;
  const service = { name: 'Haircut', price_amount: '80000', estimated_duration_minutes: 30, queue_prefix: 'A', payment_mode: 'NONE', deposit_amount: null };
  try {
    await t.test('business creation bootstraps an owner atomically', async () => {
      a = await call(owner, '/businesses', 'POST', { name: 'Test A', slug: tag + '-a' }, 201);
      b = await call(outsider, '/businesses', 'POST', { name: 'Test B', slug: tag + '-b' }, 201);
      assert.equal(a.role, 'OWNER');
      const rows = await call<MemberDto[]>(owner, '/businesses/' + a.id + '/members');
      assert.equal(rows.length, 1); ownerMember = rows[0]!;
      assert.equal(ownerMember.user_id, owner); assert.equal(ownerMember.role, 'OWNER');
      await call(newcomer, '/businesses', 'POST', { name: 'Duplicate', slug: a.slug }, 409);
      assert.equal((await client.query('SELECT 1 FROM public.profiles WHERE user_id=$1', [newcomer])).rowCount, 0, 'failed creation rolls back profile bootstrap');
      await call(guest, '/businesses', 'POST', { name: 'Guest business', slug: tag + '-guest' }, 403);
    });
    await t.test('business reads and updates cannot cross tenant boundaries', async () => {
      const list = await call<BusinessDto[]>(owner, '/businesses');
      assert.deepEqual(list.map(row => row.id), [a.id]);
      await call(owner, '/businesses/' + b.id, 'GET', undefined, 404);
      await call(owner, '/businesses/' + b.id, 'PATCH', { name: 'Attack' }, 404);
      await call(owner, '/businesses/not-a-uuid', 'GET', undefined, 400);
    });
    await t.test('branches validate their fields and globally unique slugs', async () => {
      branchA = await call(owner, '/businesses/' + a.id + '/branches', 'POST', { name: 'Branch A', public_slug: tag + '-branch-a', timezone: 'Asia/Jakarta' }, 201);
      branchB = await call(owner, '/businesses/' + a.id + '/branches', 'POST', { name: 'Branch B', public_slug: tag + '-branch-b', timezone: 'Asia/Makassar', address: 'Retained address', is_active: false }, 201);
      otherBranch = await call(outsider, '/businesses/' + b.id + '/branches', 'POST', { name: 'Other tenant', public_slug: tag + '-other' }, 201);
      await call(outsider, '/businesses/' + b.id + '/branches', 'POST', { name: 'Duplicate', public_slug: branchA.public_slug }, 409);
      await call(owner, '/businesses/' + a.id + '/branches', 'POST', { name: 'Invalid timezone', public_slug: tag + '-invalid', timezone: 'Made/Up' }, 400);
      const updated = await call<BranchDto>(owner, '/businesses/' + a.id + '/branches/' + branchB.id, 'PATCH', { name: 'Branch B renamed' });
      assert.equal(updated.timezone, 'Asia/Makassar'); assert.equal(updated.address, 'Retained address'); assert.equal(updated.is_active, false);
      await call(owner, '/businesses/' + a.id + '/branches/' + otherBranch.id, 'GET', undefined, 404);
    });
    await t.test('services preserve bigint values and validate full merged PATCH configuration', async () => {
      const path = '/businesses/' + a.id + '/branches/' + branchA.id + '/services';
      serviceX = await call(owner, path, 'POST', { ...service, price_amount: '9007199254740993', payment_mode: 'DEPOSIT', deposit_amount: '10000', description: 'Preserve me' }, 201);
      serviceY = await call(owner, path, 'POST', { ...service, name: 'Coloring', queue_prefix: 'B' }, 201);
      assert.equal(serviceX.price_amount, '9007199254740993');
      const patched = await call<ServiceDto>(owner, path + '/' + serviceX.id, 'PATCH', { name: 'Updated haircut' });
      assert.equal(patched.deposit_amount, '10000'); assert.equal(patched.payment_mode, 'DEPOSIT'); assert.equal(patched.description, 'Preserve me');
      await call(owner, path + '/' + serviceX.id, 'PATCH', { price_amount: '100' }, 400);
      await call(owner, path, 'POST', { ...service, queue_prefix: 'C', payment_mode: 'FULL', price_amount: '0' }, 400);
      await call(owner, path, 'POST', { ...service, queue_prefix: 'D', payment_mode: 'DEPOSIT', deposit_amount: '90000' }, 400);
      await call(owner, path, 'POST', service, 409);
      await call(owner, '/businesses/' + a.id + '/branches/' + branchB.id + '/services/' + serviceX.id, 'GET', undefined, 404);
      await call(owner, '/businesses/' + a.id + '/branches/' + otherBranch.id + '/services', 'POST', service, 404);
    });
    await t.test('counters can be created, renamed and deactivated inside their service only', async () => {
      const path = '/businesses/' + a.id + '/branches/' + branchA.id + '/services/' + serviceX.id + '/counters';
      counter = await call(owner, path, 'POST', { name: 'Station 1' }, 201);
      const updated = await call<CounterDto>(owner, path + '/' + counter.id, 'PATCH', { name: 'Station renamed', is_active: false });
      assert.equal(updated.is_active, false);
      const renamed = await call<CounterDto>(owner, path + '/' + counter.id, 'PATCH', { name: 'Station again' });
      assert.equal(renamed.is_active, false);
      await call(owner, '/businesses/' + a.id + '/branches/' + branchA.id + '/services/' + serviceY.id + '/counters/' + counter.id, 'PATCH', { name: 'Attack' }, 404);
    });
    await t.test('owners add existing permanent users; duplicates and guests are rejected', async () => {
      managerMember = await call(owner, '/businesses/' + a.id + '/members', 'POST', { user_id: manager, role: 'MANAGER' }, 201);
      staffMember = await call(owner, '/businesses/' + a.id + '/members', 'POST', { user_id: staff, role: 'STAFF' }, 201);
      await call(owner, '/businesses/' + a.id + '/members', 'POST', { user_id: staff, role: 'STAFF' }, 409);
      await call(owner, '/businesses/' + a.id + '/members', 'POST', { user_id: guest, role: 'STAFF' }, 400);
      await call(manager, '/businesses/' + a.id + '/members', 'GET', undefined, 403);
      await call(staff, '/businesses/' + a.id, 'PATCH', { name: 'Attack' }, 403);
    });
    await t.test('assignments cannot cross business or branch/service boundaries', async () => {
      const path = '/businesses/' + a.id + '/members/' + staffMember.id + '/assignments';
      await call(owner, path, 'PUT', { branch_ids: [otherBranch.id], service_ids: [] }, 400);
      await call(owner, path, 'PUT', { branch_ids: [branchB.id], service_ids: [serviceX.id] }, 400);
      await call(owner, '/businesses/' + b.id + '/members/' + staffMember.id + '/assignments', 'PUT', { branch_ids: [], service_ids: [] }, 404);
      await call(owner, path, 'PUT', { branch_ids: [branchA.id], service_ids: [serviceX.id] });
      await call(owner, '/businesses/' + a.id + '/members/' + managerMember.id + '/assignments', 'PUT', { branch_ids: [branchA.id], service_ids: [] });
    });
    await t.test('staff sees only assigned branches/services and cannot configure either', async () => {
      const branches = await call<BranchDto[]>(staff, '/businesses/' + a.id + '/branches');
      assert.deepEqual(branches.map(row => row.id), [branchA.id]);
      await call(staff, '/businesses/' + a.id + '/branches/' + branchB.id, 'GET', undefined, 404);
      await call(staff, '/businesses/' + a.id + '/branches/' + branchB.id, 'PATCH', { name: 'Attack' }, 403);
      const path = '/businesses/' + a.id + '/branches/' + branchA.id + '/services';
      const assigned = await call<ServiceDto[]>(staff, path); assert.deepEqual(assigned.map(row => row.id), [serviceX.id]);
      await call(staff, path + '/' + serviceY.id, 'GET', undefined, 404);
      await call(staff, path + '/' + serviceY.id, 'PATCH', { name: 'Attack' }, 403);
      await call(staff, path + '/' + serviceX.id, 'PATCH', { name: 'Attack' }, 403);
      await call(staff, path + '/' + serviceX.id + '/counters', 'POST', { name: 'Attack' }, 403);
      await call(staff, '/businesses/' + a.id + '/members/' + staffMember.id + '/assignments', 'PUT', { branch_ids: [branchB.id], service_ids: [] }, 403);
    });
    await t.test('managers configure assigned branches and gain scope only for newly created branches', async () => {
      await call(manager, '/businesses/' + a.id + '/branches/' + branchA.id, 'PATCH', { address: 'Manager update' });
      await call(manager, '/businesses/' + a.id + '/branches/' + branchB.id, 'PATCH', { name: 'Attack' }, 404);
      await call(manager, '/businesses/' + a.id + '/branches/' + branchA.id + '/services/' + serviceY.id, 'PATCH', { description: 'Manager update' });
      const created = await call<BranchDto>(manager, '/businesses/' + a.id + '/branches', 'POST', { name: 'Manager branch', public_slug: tag + '-manager' }, 201);
      await call(manager, '/businesses/' + a.id + '/branches/' + created.id);
      await call(manager, '/businesses/' + a.id, 'PATCH', { name: 'Attack' }, 403);
    });
    await t.test('the final active owner cannot be demoted or deactivated', async () => {
      const path = '/businesses/' + a.id + '/members/';
      await call(owner, path + ownerMember.id, 'PATCH', { role: 'STAFF' }, 409);
      await call(owner, path + ownerMember.id, 'PATCH', { is_active: false }, 409);
      await call(owner, path + managerMember.id, 'PATCH', { role: 'OWNER' });
      await call(manager, path + ownerMember.id, 'PATCH', { role: 'STAFF' });
      await call(manager, path + managerMember.id, 'PATCH', { role: 'MANAGER' }, 409);
      await call(manager, path + ownerMember.id, 'PATCH', { role: 'OWNER' });
      await call(owner, path + managerMember.id, 'PATCH', { role: 'MANAGER' });
      await call(manager, '/businesses/' + a.id + '/branches/' + branchA.id, 'GET', undefined, 404);
    });
    await t.test('membership deactivation clears assignments and immediately denies access', async () => {
      const updated = await call<MemberDto>(owner, '/businesses/' + a.id + '/members/' + staffMember.id, 'PATCH', { is_active: false });
      assert.deepEqual(updated.branch_ids, []); assert.deepEqual(updated.service_ids, []);
      await call(staff, '/businesses/' + a.id, 'GET', undefined, 404);
    });
    await t.test('public catalog hides inactive services, branches and businesses without exposing internal fields', async () => {
      const path = '/businesses/' + a.id + '/branches/' + branchA.id;
      await call(owner, path + '/services/' + serviceY.id, 'PATCH', { is_active: false });
      const catalog = await call<{ services: { id: string }[]; branch: object }>(null, '/public/branches/' + branchA.public_slug);
      assert.deepEqual(catalog.services.map(row => row.id), [serviceX.id]);
      assert.equal('business_id' in catalog.branch, false);
      await call(null, '/public/branches/' + branchB.public_slug, 'GET', undefined, 404);
      await call(owner, '/businesses/' + a.id, 'PATCH', { status: 'INACTIVE' });
      await call(null, '/public/branches/' + branchA.public_slug, 'GET', undefined, 404);
      await call(manager, '/businesses/' + a.id, 'GET', undefined, 404);
      await call(owner, '/businesses/' + a.id, 'PATCH', { status: 'ACTIVE' });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    auth.mock.restore();
    await serial;
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    await closePool();
  }
});
