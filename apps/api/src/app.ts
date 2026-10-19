import { createAnalyticsRouter } from './modules/analytics/routes.js';
import { createCustomerRouter } from './modules/customer/routes.js';
import { createQueueRouter } from './modules/queues/routes.js';
import express from 'express';
import { createConfigurationRouter, createPublicRouter, type TransactionRunner } from './modules/configuration/routes.js';
import cors from 'cors';
import helmet from 'helmet';
import { env, mockPaymentsEnabled,whatsapp } from './config/env.js';
import {createWhatsAppWebhook} from './modules/notifications/webhook.js';
import {createTwilioWebhook} from './modules/notifications/twilio-webhook.js';
import {withTransaction} from './db/transaction.js';
import { authRouter } from './modules/auth/routes.js';
import { healthRouter } from './modules/health/routes.js';
import { errorHandler } from './middleware/error-handler.js';

export function createApp(options: { runTransaction?: TransactionRunner; disableMockPayments?: boolean } = {}) {
  const app = express();
  const mockEnabled = mockPaymentsEnabled && !options.disableMockPayments;
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN }));
  // Signature validation must see the exact bytes BEFORE express.json consumes them.
  app.use('/api/v1/webhooks/whatsapp',createWhatsAppWebhook(whatsapp,options.runTransaction??withTransaction));
  app.use('/api/v1/webhooks/twilio',createTwilioWebhook(whatsapp,options.runTransaction??withTransaction));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/businesses', createAnalyticsRouter(options.runTransaction));
  app.use('/api/v1/businesses', createQueueRouter(options.runTransaction));
  app.use('/api/v1/businesses', createConfigurationRouter(options.runTransaction));
  app.use('/api/v1/customer', createCustomerRouter(options.runTransaction,mockEnabled));
  app.use('/api/v1/public', createPublicRouter(options.runTransaction,mockEnabled));
  app.use((_req, res) => { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }); });
  app.use(errorHandler);
  return app;
}
