import { Router } from 'express';
import type { HealthResponse } from '@qevra/contracts';
import { getPool } from '../../db/client.js';

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
  } catch {
    // Never return or log driver messages: they can contain connection details.
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});
