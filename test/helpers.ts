import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.ts';
import { config as baseConfig, type Config } from '../src/config.ts';
import { MemoryBroker, type Broker } from '../src/infra/broker.ts';
import { MemoryRateLimiter, type RateLimiter } from '../src/infra/rate-limit.ts';
import { MemoryStore } from '../src/store/memory.ts';
import type { Store } from '../src/store/types.ts';
import { Hub } from '../src/ws/hub.ts';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...baseConfig,
    storeDriver: 'memory',
    brokerDriver: 'memory',
    port: 0,
    instanceId: 'test',
    messagePageSize: 10,
    rateLimit: { limit: 5, windowMs: 10_000 },
    ...overrides,
  };
}

export interface Harness {
  config: Config;
  store: Store;
  broker: Broker;
  rateLimiter: RateLimiter;
  server: http.Server;
  hub: Hub;
  baseUrl: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<Config>;
  /** Share a store/broker across harnesses to simulate several API instances. */
  store?: Store;
  broker?: Broker;
  rateLimiter?: RateLimiter;
}

/** Boots a complete app — HTTP routes and WebSocket hub — on an ephemeral port. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = testConfig(options.config);
  const store = options.store ?? new MemoryStore();
  const broker = options.broker ?? new MemoryBroker(config.instanceId);
  const rateLimiter = options.rateLimiter ?? new MemoryRateLimiter(config.rateLimit);

  const app = createApp({ store, broker, rateLimiter, config });
  const server = http.createServer(app);
  const hub = new Hub(store, broker, config);
  hub.attach(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    config,
    store,
    broker,
    rateLimiter,
    server,
    hub,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------ HTTP */

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export async function api<T = any>(
  harness: Harness,
  path: string,
  init: RequestInit & { userId?: number | null } = {},
): Promise<ApiResponse<T>> {
  const { userId = 1, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('content-type', 'application/json');
  // An explicit x-user-id in init.headers wins, so tests can send a malformed one.
  if (userId !== null && !headers.has('x-user-id')) headers.set('x-user-id', String(userId));

  const res = await fetch(`${harness.baseUrl}${path}`, { ...rest, headers });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

export const postJson = (
  harness: Harness,
  path: string,
  body: unknown,
  init: RequestInit & { userId?: number | null } = {},
) => api(harness, path, { ...init, method: 'POST', body: JSON.stringify(body) });

/* -------------------------------------------------------------- fixtures */

export interface Fixture {
  supportId: number;
  designId: number;
}

/**
 * Alice(1) + Bob(2) in "Support"; Alice(1) + Carol(3) in "Design".
 * Carol therefore has no visibility into "Support", which is what the
 * authorisation and search-scoping tests lean on.
 */
export async function seedFixture(store: Store): Promise<Fixture> {
  const support = await store.createConversation('Support — order #1042', [1, 2]);
  const design = await store.createConversation('Design sync', [1, 3]);
  return { supportId: support.id, designId: design.id };
}

/* --------------------------------------------------------------- sockets */

export interface TestSocket {
  socket: WebSocket;
  /** Frames received so far, in order. */
  frames: any[];
  waitFor(predicate: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
  send(frame: unknown): void;
  close(): Promise<void>;
}

export async function connectSocket(harness: Harness, userId: number): Promise<TestSocket> {
  const url = `${harness.baseUrl.replace('http', 'ws')}/?userId=${userId}`;
  const socket = new WebSocket(url);
  const frames: any[] = [];
  const listeners = new Set<(frame: any) => void>();

  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    for (const listener of listeners) listener(frame);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('close', (code) => reject(new Error(`socket closed early: ${code}`)));
  });

  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    waitFor(predicate, timeoutMs = 2000) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timed out waiting for frame; saw ${JSON.stringify(frames)}`));
        }, timeoutMs);
        const listener = (frame: any) => {
          if (!predicate(frame)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(frame);
        };
        listeners.add(listener);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', () => resolve());
        socket.close();
      });
    },
  };
}

/** Subscribes and waits for the server's authorised-subscription echo. */
export async function subscribe(
  client: TestSocket,
  conversationIds: number[],
): Promise<number[]> {
  client.send({ type: 'subscribe', conversationIds });
  const ack = await client.waitFor((f) => f.type === 'subscribed');
  return ack.conversationIds;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
