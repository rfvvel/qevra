import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';
const config = { ...(existsSync('apps/api/.env') ? parse(readFileSync('apps/api/.env')) : {}), ...process.env };
if (!config.DATABASE_URL) { console.error('Database configuration missing.'); process.exit(1); }
const client = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 30000 });
let activeVersion;
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('qevra:migrations'))");
  await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
  await client.query('CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text)');
  await client.query('COMMIT');
  const files = readdirSync('supabase/migrations').filter(file => /^\d{14}_.+\.sql$/.test(file)).sort();
  for (const file of files) {
    const version = file.slice(0, 14); activeVersion = version;
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('qevra:migrations'))");
    const exists = await client.query('SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1', [version]);
    if (exists.rowCount) { await client.query('COMMIT'); console.log(JSON.stringify({ version, result: 'already-applied' })); continue; }
    const source = readFileSync('supabase/migrations/' + file, 'utf8');
    const sql = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await client.query(sql);
    await client.query('INSERT INTO supabase_migrations.schema_migrations(version, statements, name) VALUES ($1,$2,$3)', [version, [sql], file.slice(15, -4)]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ version, result: 'applied' }));
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.log(JSON.stringify({ version: activeVersion, result: 'failed', code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'ERROR' }));
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
