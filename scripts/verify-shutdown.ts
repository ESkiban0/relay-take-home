/**
 * Times graceful shutdown with a WebSocket client attached.
 *
 *   npx tsx scripts/verify-shutdown.ts
 *
 * `server.close()` stops accepting new connections but its callback does not
 * fire until every *existing* connection has ended — and a WebSocket never ends
 * on its own. So the order in which the server and the hub are closed decides
 * whether shutdown completes in milliseconds or hangs until the orchestrator
 * gives up and sends SIGKILL.
 *
 * Runs entirely on the in-memory drivers, so it needs no MySQL/Mongo/Redis.
 */
export {};

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 3999);
const GRACE_MS = Number(process.env.GRACE_MS ?? 15_000);

const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STORE_DRIVER: 'memory',
    BROKER_DRIVER: 'memory',
    INSTANCE_ID: 'shutdown-probe',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const out: string[] = [];
child.stdout.on('data', (d) => out.push(String(d)));
child.stderr.on('data', (d) => out.push(String(d)));

async function waitForListening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server never came up');
}

await waitForListening();
console.log('server up');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?userId=1`);
await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve());
  ws.once('error', reject);
});
console.log('websocket attached — this is the connection that blocks server.close()');

const exited = new Promise<{ ms: number; timedOut: boolean }>((resolve) => {
  const started = Date.now();
  const timer = setTimeout(() => {
    resolve({ ms: Date.now() - started, timedOut: true });
    child.kill('SIGKILL');
  }, GRACE_MS);
  child.once('exit', () => {
    clearTimeout(timer);
    resolve({ ms: Date.now() - started, timedOut: false });
  });
});

console.log('sending SIGTERM…');
child.kill('SIGTERM');

const { ms, timedOut } = await exited;
console.log(out.join('').trim());

if (timedOut) {
  console.log(`\nFAIL  still running ${ms}ms after SIGTERM — had to SIGKILL it.`);
  console.log('      An orchestrator would wait out its grace period on every deploy.');
  process.exit(1);
}
console.log(`\nPASS  exited cleanly ${ms}ms after SIGTERM, with a socket still attached.`);
ws.close();
process.exit(0);
