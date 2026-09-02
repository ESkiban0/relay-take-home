import { config } from './config.ts';
import { startServer } from './server.ts';

const running = await startServer(config);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  await running.stop();
  process.exit(0);
}

// Without these, `docker compose down` waits out the grace period on every
// instance and Redis/MySQL connections are torn down mid-flight.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
