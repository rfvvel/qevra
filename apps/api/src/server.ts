import { assertProductionReady } from './config/production.js';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/client.js';

assertProductionReady(env);
const server = createApp().listen(env.PORT, '0.0.0.0', () => console.log(`Qevra API listening on port ${env.PORT}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => { void closePool().then(() => process.exit(0)); });
  });
}
