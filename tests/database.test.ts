import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';

test('migration exposes tenant constraints and denies browser access', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const tables = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [['profiles', 'businesses', 'business_members', 'branches', 'services', 'service_counters', 'queue_sessions', 'join_requests', 'queue_tickets', 'queue_events', 'branch_members', 'staff_services', 'payments', 'payment_events', 'notifications', 'notification_events']],
    );
    assert.equal(tables.rows.length, 16);
    assert.ok(tables.rows.every(row => row.relrowsecurity));
    for (const table of tables.rows) {
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const grant = await client.query<{ allowed: boolean }>('SELECT has_table_privilege($1, $2, $3) AS allowed', [role, 'public.' + table.relname, privilege]);
          assert.equal(grant.rows[0]?.allowed, false, 'Browser privileges must be denied');
        }
      }
    }
    const grants = await client.query<{ allowed: boolean }>(`SELECT has_table_privilege('authenticated', 'public.queue_tickets', 'SELECT') AS allowed`);
    assert.equal(grants.rows[0]?.allowed, false);
    await client.query(`INSERT INTO auth.users (id) VALUES ('10000000-0000-4000-8000-000000000001')`);
    await client.query(`INSERT INTO public.profiles(user_id, display_name) VALUES ('10000000-0000-4000-8000-000000000001', 'Test owner')`);
    await client.query(`INSERT INTO public.businesses(id, name, slug, created_by) VALUES
      ('20000000-0000-4000-8000-000000000001', 'A', 'integration-test-a', '10000000-0000-4000-8000-000000000001'),
      ('20000000-0000-4000-8000-000000000002', 'B', 'integration-test-b', '10000000-0000-4000-8000-000000000001')`);
    await client.query(`INSERT INTO public.branches(id, business_id, name, public_slug) VALUES
      ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Branch', 'integration-test-branch')`);
    await client.query('SAVEPOINT tenant_check');
    await assert.rejects(client.query(`INSERT INTO public.services(business_id, branch_id, name, estimated_duration_minutes, queue_prefix)
      VALUES ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'Wrong tenant', 30, 'A')`), { code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT tenant_check');
    await client.query('SAVEPOINT deposit_check');
    await assert.rejects(client.query(`INSERT INTO public.services(business_id, branch_id, name, estimated_duration_minutes, queue_prefix, payment_mode, price_amount, deposit_amount)
      VALUES ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Invalid deposit', 30, 'A', 'DEPOSIT', 50000, NULL)`), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT deposit_check');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
