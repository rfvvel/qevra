import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';

const version = '20260919000100';
const names = ['profiles', 'businesses', 'business_members', 'branches', 'branch_members', 'services', 'staff_services', 'service_counters', 'queue_sessions', 'join_requests', 'queue_tickets', 'queue_events'];
const env = parse(readFileSync('apps/api/.env'));
const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 30000 });
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('qevra:foundation-migration'))");
  const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)", [names]);
  const history = await client.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present");
  let recorded = false;
  if (history.rows[0].present) {
    const result = await client.query('SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1', [version]);
    recorded = result.rowCount === 1;
  }
  if (recorded) {
    if (existing.rowCount !== names.length) throw new Error('SCHEMA_HISTORY_MISMATCH');
    console.log(JSON.stringify({ migration: 'already-applied', version }));
  } else {
    if (existing.rowCount !== 0) throw new Error('UNTRACKED_EXISTING_TABLES');
    const source = readFileSync('supabase/migrations/20260919000100_foundation.sql', 'utf8');
    // Preserve the migration file unchanged; its outer transaction is managed here
    // so schema and standard Supabase CLI migration history commit atomically.
    const sql = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await client.query(sql);
    await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
    await client.query('CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text)');
    await client.query('INSERT INTO supabase_migrations.schema_migrations(version, statements, name) VALUES ($1, $2, $3)', [version, [sql], 'foundation']);
    console.log(JSON.stringify({ migration: 'applied-in-transaction', version }));
  }
  await client.query('COMMIT');
  const verified = await client.query("SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename", [names]);
  console.log(JSON.stringify({ committed: true, tables: verified.rows, count: verified.rowCount }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  const allowed = ['SCHEMA_HISTORY_MISMATCH', 'UNTRACKED_EXISTING_TABLES'];
  console.log(JSON.stringify({ migration: 'failed', code: allowed.includes(error?.message) ? error.message : /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'ERROR' }));
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
