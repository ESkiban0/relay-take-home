import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { MemoryBroker } from '../src/infra/broker.ts';
import { MemoryRateLimiter } from '../src/infra/rate-limit.ts';
import { MemoryStore } from '../src/store/memory.ts';
import {
  connectSocket,
  postJson,
  seedFixture,
  startHarness,
  subscribe,
  testConfig,
  wait,
  type Harness,
  type TestSocket,
} from './helpers.ts';

describe('websocket hub', () => {
  let harness: Harness;
  let supportId: number;
  let designId: number;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    harness = await startHarness({ config: { typingTtlMs: 4000 } });
    ({ supportId, designId } = await seedFixture(harness.store));
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await harness.close();
  });

  async function open(userId: number): Promise<TestSocket> {
    const client = await connectSocket(harness, userId);
    sockets.push(client);
    return client;
  }

  it('rejects a connection without a userId', async () => {
    const socket = new WebSocket(`${harness.baseUrl.replace('http', 'ws')}/`);
    const code = await new Promise<number>((resolve) => socket.once('close', resolve));
    assert.equal(code, 4001);
  });

  it('delivers a new message to a subscriber', async () => {
    const bob = await open(2);
    await subscribe(bob, [supportId]);

    await postJson(harness, '/api/messages', { conversationId: supportId, body: 'ping' });

    const frame = await bob.waitFor((f) => f.type === 'message');
    assert.equal(frame.body, 'ping');
    assert.equal(frame.conversationId, supportId);
    assert.equal(frame.senderId, 1);
  });

  describe('subscription authorisation', () => {
    it('drops conversations the user does not belong to', async () => {
      // Carol(3) is only in "Design sync" but asks for both.
      const carol = await open(3);
      const granted = await subscribe(carol, [supportId, designId]);
      assert.deepEqual(granted, [designId]);
    });

    it('does not deliver messages from an unauthorised conversation', async () => {
      const carol = await open(3);
      await subscribe(carol, [supportId, designId]);

      await postJson(harness, '/api/messages', { conversationId: supportId, body: 'private' });
      // Then something she *is* allowed to see, as a synchronisation point: if
      // the private message were leaking it would have arrived before this.
      await postJson(harness, '/api/messages', { conversationId: designId, body: 'public' });

      const frame = await carol.waitFor((f) => f.type === 'message');
      assert.equal(frame.body, 'public');
      assert.equal(
        carol.frames.filter((f) => f.type === 'message').length,
        1,
        'exactly one message reached Carol',
      );
    });
  });

  describe('typing', () => {
    it('reaches other participants but not the typist', async () => {
      const alice = await open(1);
      const bob = await open(2);
      await subscribe(alice, [supportId]);
      await subscribe(bob, [supportId]);

      alice.send({ type: 'typing', conversationId: supportId });

      const frame = await bob.waitFor((f) => f.type === 'typing');
      assert.equal(frame.userId, 1);
      assert.equal(frame.conversationId, supportId);
      assert.ok(frame.expiresAt > Date.now());

      await wait(50);
      assert.equal(alice.frames.filter((f) => f.type === 'typing').length, 0);
    });

    it('is ignored for a conversation the sender is not subscribed to', async () => {
      const carol = await open(3);
      const bob = await open(2);
      await subscribe(carol, [designId]);
      await subscribe(bob, [supportId]);

      carol.send({ type: 'typing', conversationId: supportId });
      await wait(100);

      assert.equal(bob.frames.filter((f) => f.type === 'typing').length, 0);
    });

    it('carries an expiry so a vanished typist clears on its own', async () => {
      const short = await startHarness({ config: { typingTtlMs: 50 } });
      try {
        const { supportId: id } = await seedFixture(short.store);
        const alice = await connectSocket(short, 1);
        const bob = await connectSocket(short, 2);
        await subscribe(alice, [id]);
        await subscribe(bob, [id]);

        alice.send({ type: 'typing', conversationId: id });
        const frame = await bob.waitFor((f) => f.type === 'typing');

        await wait(80);
        assert.ok(frame.expiresAt <= Date.now(), 'signal has lapsed without any further frame');

        await alice.close();
        await bob.close();
      } finally {
        await short.close();
      }
    });
  });

  it('ignores malformed frames instead of dropping the connection', async () => {
    const bob = await open(2);
    bob.socket.send('not json');
    bob.socket.send(JSON.stringify({ type: 'nonsense' }));
    await wait(50);

    assert.equal(bob.socket.readyState, WebSocket.OPEN);
    const granted = await subscribe(bob, [supportId]);
    assert.deepEqual(granted, [supportId]);
  });
});

/**
 * The multi-instance property from tasks/multi-instance.md.
 *
 * Two independent app instances, each with its own HTTP server and its own WS
 * hub, sharing one store and one broker — the shape `--scale api=3` produces
 * behind Envoy. A client parked on instance B has to see a message that was
 * POSTed to instance A. With the original in-process `clients` Set it could not.
 */
describe('multiple API instances', () => {
  let store: MemoryStore;
  let broker: MemoryBroker;
  let instanceA: Harness;
  let instanceB: Harness;
  let supportId: number;

  beforeEach(async () => {
    store = new MemoryStore();
    broker = new MemoryBroker('shared');
    const shared = {
      store,
      broker,
      rateLimiter: new MemoryRateLimiter(testConfig().rateLimit),
    };
    instanceA = await startHarness({ ...shared, config: { instanceId: 'a' } });
    instanceB = await startHarness({ ...shared, config: { instanceId: 'b' } });
    ({ supportId } = await seedFixture(store));
  });
  afterEach(async () => {
    await Promise.all([instanceA.close(), instanceB.close()]);
  });

  it('delivers a message posted to one instance to a socket on another', async () => {
    const bob = await connectSocket(instanceB, 2);
    try {
      await subscribe(bob, [supportId]);

      await postJson(instanceA, '/api/messages', { conversationId: supportId, body: 'cross' });

      const frame = await bob.waitFor((f) => f.type === 'message');
      assert.equal(frame.body, 'cross');
    } finally {
      await bob.close();
    }
  });

  it('delivers a typing signal across instances', async () => {
    const alice = await connectSocket(instanceA, 1);
    const bob = await connectSocket(instanceB, 2);
    try {
      await subscribe(alice, [supportId]);
      await subscribe(bob, [supportId]);

      alice.send({ type: 'typing', conversationId: supportId });

      const frame = await bob.waitFor((f) => f.type === 'typing');
      assert.equal(frame.userId, 1);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('delivers exactly once to each subscriber, including on the origin instance', async () => {
    // The publisher never broadcasts locally *and* publishes: it only
    // publishes, and delivers on the subscription. Otherwise the sender's own
    // instance would paint every message twice.
    const alice = await connectSocket(instanceA, 1);
    const bob = await connectSocket(instanceB, 2);
    try {
      await subscribe(alice, [supportId]);
      await subscribe(bob, [supportId]);

      await postJson(instanceA, '/api/messages', { conversationId: supportId, body: 'once' });
      await bob.waitFor((f) => f.type === 'message');
      await wait(100);

      assert.equal(alice.frames.filter((f) => f.type === 'message').length, 1);
      assert.equal(bob.frames.filter((f) => f.type === 'message').length, 1);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});

describe('typing throttle', () => {
  let harness: Harness;
  let supportId: number;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    harness = await startHarness({ config: { typingMinIntervalMs: 1000 } });
    ({ supportId } = await seedFixture(harness.store));
  });
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    await harness.close();
  });

  it('collapses a flood of typing frames from one socket', async () => {
    const alice = await connectSocket(harness, 1);
    const bob = await connectSocket(harness, 2);
    sockets.push(alice, bob);
    await subscribe(alice, [supportId]);
    await subscribe(bob, [supportId]);

    // A client that ignores the browser's 1.5s throttle. Unbounded, each of
    // these fans out through the broker to every subscriber in the room.
    for (let i = 0; i < 500; i++) {
      alice.send({ type: 'typing', conversationId: supportId });
    }
    await wait(200);

    const delivered = bob.frames.filter((f) => f.type === 'typing').length;
    assert.equal(delivered, 1, `500 frames should collapse to 1, got ${delivered}`);
  });

  it('allows a further signal once the interval has passed', async () => {
    const short = await startHarness({ config: { typingMinIntervalMs: 50 } });
    try {
      const { supportId: id } = await seedFixture(short.store);
      const alice = await connectSocket(short, 1);
      const bob = await connectSocket(short, 2);
      await subscribe(alice, [id]);
      await subscribe(bob, [id]);

      alice.send({ type: 'typing', conversationId: id });
      await bob.waitFor((f) => f.type === 'typing');
      await wait(80);
      alice.send({ type: 'typing', conversationId: id });
      await wait(120);

      assert.equal(bob.frames.filter((f) => f.type === 'typing').length, 2);
      await alice.close();
      await bob.close();
    } finally {
      await short.close();
    }
  });
});
