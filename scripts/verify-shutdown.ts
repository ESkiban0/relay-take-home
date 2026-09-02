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
 *
 * POSIX only. On Windows there are no real signals — child.kill('SIGTERM')
 * calls TerminateProcess, so the handler can never run and this probe reports a
 * failure that says nothing about the code.
 */
export {};

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 3999);
const GRACE_MS = Number(process.env.GRACE_MS ?? 15_000);

if (process.platform === 'win32') {
  console.log('SKIP  no real signals on Windows; run this on Linux (or in Docker).');
  process.exit(0);
}

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
// Streamed, not buffered: a process that exits milliseconds after SIGTERM can
// otherwise lose its final lines to the pipe, which makes a hard kill look
// indistinguishable from a clean shutdown.
child.stdout.on('data', (d) => {
  out.push(String(d));
  process.stdout.write(`  child> ${String(d)}`);
});
child.stderr.on('data', (d) => {
  out.push(String(d));
  process.stdout.write(`  child! ${String(d)}`);
});

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

interface Exit {
  ms: number;
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

const exited = new Promise<Exit>((resolve) => {
  const started = Date.now();
  const timer = setTimeout(() => {
    resolve({ ms: Date.now() - started, timedOut: true, code: null, signal: null });
    child.kill('SIGKILL');
  }, GRACE_MS);
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ ms: Date.now() - started, timedOut: false, code, signal });
  });
});

console.log('sending SIGTERM…');
child.kill('SIGTERM');

const { ms, timedOut, code, signal } = await exited;
// Give the pipes a moment so the child's last lines are not lost.
await new Promise((r) => setTimeout(r, 200));

if (timedOut) {
  console.log(`\nFAIL  still running ${ms}ms after SIGTERM — had to SIGKILL it.`);
  console.log('      An orchestrator would wait out its grace period on every deploy.');
  process.exit(1);
}

// Exiting fast is not the same as exiting gracefully. If the handler ran, it
// logged; if the kernel's default SIGTERM disposition ran instead, it did not.
const ranHandler = out.join('').includes('[shutdown]');
console.log(
  `\nexited after ${ms}ms — code=${code} signal=${signal} handlerLogged=${ranHandler}`,
);
if (!ranHandler) {
  console.log('FAIL  the process died without running the shutdown handler.');
  process.exit(1);
}
console.log('PASS  shutdown handler ran and the process exited, socket still attached.');
ws.close();
process.exit(0);
