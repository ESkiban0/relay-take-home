/**
 * Verifies the property from tasks/multi-instance.md against a running stack.
 *
 *   docker compose up -d --scale api=3
 *   npx tsx scripts/verify-multi-instance.ts
 *
 * Everything goes through the proxy on :3000, so which API instance serves the
 * WebSocket and which serves the POST is Envoy's choice, not ours — that is the
 * point. With the original in-process client Set, the message would reach the
 * socket only when both happened to land on the same instance.
 */
export {};

import { WebSocket } from 'ws';

const BASE = process.env.RELAY_URL ?? 'http://localhost:3000';
const CONVERSATION_ID = Number(process.env.CONVERSATION_ID ?? 1);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

async function healthz(): Promise<string> {
  const res = await fetch(`${BASE}/healthz`);
  return (await res.json()).instanceId;
}

function open(userId: number): Promise<WebSocket> {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/?userId=${userId}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws: WebSocket, predicate: (f: any) => boolean, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), ms);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (!predicate(frame)) return;
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

const post = (userId: number, body: unknown) =>
  fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': String(userId) },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------- 1. spread

const seen = new Set<string>();
for (let i = 0; i < 12; i++) seen.add(await healthz());
check(
  'proxy spreads HTTP across instances',
  seen.size > 1,
  `${seen.size} distinct instanceId(s) over 12 requests: ${[...seen].join(', ')}`,
);

// ------------------------------------------------- 2. cross-instance message

const bob = await open(2);
bob.send(JSON.stringify({ type: 'subscribe', conversationIds: [CONVERSATION_ID] }));
await waitFor(bob, (f) => f.type === 'subscribed');

const marker = `cross-instance ${Date.now()}`;
const delivery = waitFor(bob, (f) => f.type === 'message' && f.body === marker);
const posted = await post(1, { conversationId: CONVERSATION_ID, body: marker });

try {
  const frame = await delivery;
  check(
    'message posted to one instance reaches a socket on another',
    frame.body === marker,
    `POST returned ${posted.status}; socket received id=${frame.id}`,
  );
} catch (err) {
  check('message posted to one instance reaches a socket on another', false, String(err));
}

// -------------------------------------------------- 3. cross-instance typing

const alice = await open(1);
alice.send(JSON.stringify({ type: 'subscribe', conversationIds: [CONVERSATION_ID] }));
await waitFor(alice, (f) => f.type === 'subscribed');

const typing = waitFor(bob, (f) => f.type === 'typing');
alice.send(JSON.stringify({ type: 'typing', conversationId: CONVERSATION_ID }));

try {
  const frame = await typing;
  check(
    'typing signal crosses instances',
    frame.userId === 1,
    `received typing from user ${frame.userId}, expires in ${frame.expiresAt - Date.now()}ms`,
  );
} catch (err) {
  check('typing signal crosses instances', false, String(err));
}

// --------------------------------------------- 4. shared rate-limit budget

// The limit must be global, not per instance: with three instances and a
// per-process counter this would allow 3x the configured budget.
// The sender must be a participant, or every request is rejected as 403 before
// the limiter is consulted and the check proves nothing.
const LIMIT = Number(process.env.RATE_LIMIT_MESSAGES ?? 5);
await new Promise((r) => setTimeout(r, Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000) + 1000));

const codes: number[] = [];
for (let i = 0; i < LIMIT * 2; i++) {
  const res = await post(2, { conversationId: CONVERSATION_ID, body: `limit probe ` });
  codes.push(res.status);
}
const accepted = codes.filter((c) => c === 201).length;
const forbidden = codes.filter((c) => c === 403).length;

check(
  'rate limit budget is shared across instances',
  forbidden === 0 && accepted === LIMIT,
  forbidden
    ? `sender is not a participant (x403) — inconclusive, pick a conversation they belong to`
    : ` of  accepted; limit is , ` +
      `a per-process counter across 3 instances would allow up to -e`,
);

bob.close();
alice.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
