import { Router } from 'express';
import type { HealthResponse } from '@qevra/contracts';
import { getPool } from '../../db/client.js';
import { logDatabaseFailure } from '../../db/diagnostics.js';

export const healthRouter = Router();
healthRouter.get('/', (_req, res) => {
  const response: HealthResponse = { status: 'ok', service: 'qevra-api' };
  res.json(response);
});

healthRouter.get('/database', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await getPool().query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    // Never return or log driver messages: they can contain connection details.
    logDatabaseFailure('health', error);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});
