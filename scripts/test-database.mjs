import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { spawnSync } from 'node:child_process';
const config = parse(readFileSync('apps/api/.env'));
if (!config.DATABASE_URL) { console.log('Database test configuration missing.'); process.exit(1); }
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...(process.argv.includes('--registration') ? ['tests/registration.integration.test.ts'] : process.argv.includes('--analytics') ? ['tests/analytics.integration.test.ts'] : process.argv.includes('--notifications') ? ['tests/notifications.integration.test.ts'] : process.argv.includes('--schema') ? ['tests/database.test.ts'] : process.argv.includes('--payments') ? ['tests/payment.integration.test.ts'] : process.argv.includes('--customer') ? ['tests/customer.integration.test.ts'] : process.argv.includes('--queue') ? ['tests/queue.integration.test.ts'] : ['tests/database.test.ts', 'tests/configuration.integration.test.ts', 'tests/queue.integration.test.ts', 'tests/customer.integration.test.ts', 'tests/payment.integration.test.ts', 'tests/notifications.integration.test.ts', 'tests/analytics.integration.test.ts', 'tests/registration.integration.test.ts'])], {
  env: { ...process.env, TEST_DATABASE_URL: config.DATABASE_URL },
  encoding: 'utf8',
});
const forbidden = Object.entries(config).filter(([key, value]) => /KEY|PASSWORD|DATABASE_URL|SECRET|TOKEN/.test(key) && value.length > 5).map(([, value]) => value);
try { forbidden.push(decodeURIComponent(new URL(config.DATABASE_URL).password)); } catch { /* no URL output */ }
const output = (result.stdout ?? '') + (result.stderr ?? '');
if (forbidden.filter(Boolean).some(value => output.includes(value))) {
  console.log('Database test output suppressed because it contained sensitive configuration.');
  process.exitCode = 1;
} else { process.stdout.write(output); process.exitCode = result.status ?? 1; }
