import { loadConfig } from './config.ts';
import { createLogger } from './log.ts';
import { startServer } from './server.ts';

const cfg = loadConfig();
const log = createLogger(cfg.logLevel, { svc: 'rest-in-pump' });

const server = await startServer(cfg, log);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
process.on('uncaughtException', (err) => { log.error('uncaught exception', { err }); process.exit(1); });
