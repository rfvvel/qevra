import pg from 'pg';
import { env } from '../config/env.js';
import { HttpError } from '../shared/http-error.js';
import {databaseOptions} from '../config/database.js';
import {logDatabaseFailure} from './diagnostics.js';

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!env.DATABASE_URL) throw new HttpError(503, 'DATABASE_NOT_CONFIGURED', 'Database is not configured.');
  if (!pool) {
    pool = new pg.Pool({ ...databaseOptions(env), max: 10, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', error => logDatabaseFailure('idle_pool', error));
  }
  return pool;
}
export async function closePool(): Promise<void> { await pool?.end(); }
