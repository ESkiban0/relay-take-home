/**
 * Failure-mode probes against a running stack. Unlike the test suite, these
 * need real Redis/Mongo/MySQL because the behaviour under test *is* the
 * behaviour of those clients when the service goes away.
 *
 *   docker compose up -d
 *   npx tsx scripts/verify-resilience.ts <probe>
 *
 * Probes:
 *   ws-recovery   hold a socket open; report every frame and close event
 *   send-timeout  time a POST and report what comes back
 */
export {};

import { WebSocket } from 'ws';

const BASE = process.env.RELAY_URL ?? 'http://localhost:3000';
const probe = process.argv[2] ?? 'ws-recovery';

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...args: unknown[]) => console.log(stamp(), ...args);

if (probe === 'ws-recovery') {
  const durationMs = Number(process.env.DURATION_MS ?? 60_000);
  const conversationId = Number(process.env.CONVERSATION_ID ?? 1);

  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/?userId=2`);
  ws.on('open', () => {
    log('socket open');
    ws.send(JSON.stringify({ type: 'subscribe', conversationIds: [conversationId] }));
  });
  ws.on('message', (raw) => log('frame:', raw.toString().slice(0, 120)));
  ws.on('close', (code) => log('socket CLOSED, code', code));
  ws.on('error', (err) => log('socket error:', String(err)));

  setTimeout(() => {
    log('done watching');
    ws.close();
    process.exit(0);
  }, durationMs);
}

if (probe === 'send-timeout') {
  const started = Date.now();
  const controller = new AbortController();
  const budgetMs = Number(process.env.BUDGET_MS ?? 120_000);
  const timer = setTimeout(() => controller.abort(), budgetMs);

  try {
    const res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': '1' },
      body: JSON.stringify({
        conversationId: Number(process.env.CONVERSATION_ID ?? 1),
        body: process.env.BODY ?? 'resilience probe',
      }),
      signal: controller.signal,
    });
    log(`HTTP ${res.status} after ${Date.now() - started}ms:`, (await res.text()).slice(0, 200));
  } catch (err) {
    log(`no response after ${Date.now() - started}ms:`, String(err));
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}
