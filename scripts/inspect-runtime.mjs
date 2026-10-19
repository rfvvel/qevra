import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';

const api = parse(readFileSync('apps/api/.env'));
const web = parse(readFileSync('apps/web/.env'));
const requiredApi = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DATABASE_URL'];
const requiredWeb = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
const status = {
  apiVariables: Object.fromEntries(requiredApi.map(k => [k, Boolean(api[k])])),
  webVariables: Object.fromEntries(requiredWeb.map(k => [k, Boolean(web[k])])),
  sameSupabaseProject: api.SUPABASE_URL === web.VITE_SUPABASE_URL,
  samePublicKey: api.SUPABASE_PUBLISHABLE_KEY === web.VITE_SUPABASE_PUBLISHABLE_KEY,
  apiRouting: web.VITE_API_URL === '/api/v1' || !web.VITE_API_URL ? 'vite-proxy' : 'explicit-url',
};
console.log(JSON.stringify(status));
let client;
try {
  client = new pg.Client({ connectionString: api.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 15000 });
  await client.connect();
  const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  console.log(JSON.stringify({ postgres: 'connected', tls: tls.rows[0]?.ssl === true }));
  const tables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  console.log(JSON.stringify({ publicTables: tables.rows.map(r => r.tablename) }));
  const history = await client.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present");
  if (history.rows[0].present) {
    const result = await client.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version');
    console.log(JSON.stringify({ migrationVersions: result.rows.map(r => r.version) }));
  } else console.log(JSON.stringify({ migrationHistory: 'absent' }));
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'CONNECTION_FAILED';
  console.log(JSON.stringify({ postgres: 'failed', code }));
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
try {
  const response = await fetch(`${api.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: api.SUPABASE_PUBLISHABLE_KEY }, signal: AbortSignal.timeout(15000) });
  const settings = await response.json();
  if (!response.ok) process.exitCode = 1;
  console.log(JSON.stringify({ authSettingsHttp: response.status, emailEnabled: settings.external?.email === true, anonymousEnabled: settings.external?.anonymous_users === true || settings.external?.anonymous === true }));
} catch { console.log(JSON.stringify({ authSettings: 'unreachable' })); process.exitCode = 1; }
