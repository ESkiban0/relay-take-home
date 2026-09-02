import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MemoryRateLimiter } from '../src/infra/rate-limit.ts';
import { postJson, seedFixture, startHarness, wait, type Harness } from './helpers.ts';

describe('MemoryRateLimiter', () => {
  it('allows exactly `limit` calls per window', async () => {
    const limiter = new MemoryRateLimiter({ limit: 3, windowMs: 1000 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.consume('k'));

    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, true, false, false],
    );
    assert.deepEqual(
      results.slice(0, 3).map((r) => r.remaining),
      [2, 1, 0],
    );
  });

  it('reports a retry delay bounded by the window', async () => {
    const limiter = new MemoryRateLimiter({ limit: 1, windowMs: 200 });
    await limiter.consume('k');
    const denied = await limiter.consume('k');

    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 200, `got ${denied.retryAfterMs}`);
  });

  it('lets calls through again once the window slides past them', async () => {
    const limiter = new MemoryRateLimiter({ limit: 2, windowMs: 120 });
    await limiter.consume('k');
    await limiter.consume('k');
    assert.equal((await limiter.consume('k')).allowed, false);

    await wait(150);
    assert.equal((await limiter.consume('k')).allowed, true);
  });

  it('does not let a burst straddle a window boundary', async () => {
    // The failure mode of a fixed-window counter: `limit` calls at the end of
    // one window plus `limit` at the start of the next. A sliding window keeps
    // the guarantee at every position.
    const limiter = new MemoryRateLimiter({ limit: 3, windowMs: 200 });
    for (let i = 0; i < 3; i++) assert.equal((await limiter.consume('k')).allowed, true);

    await wait(120); // past a fixed window's reset, still inside the sliding one
    assert.equal((await limiter.consume('k')).allowed, false);
  });

  it('keys are independent', async () => {
    const limiter = new MemoryRateLimiter({ limit: 1, windowMs: 1000 });
    assert.equal((await limiter.consume('a')).allowed, true);
    assert.equal((await limiter.consume('b')).allowed, true);
    assert.equal((await limiter.consume('a')).allowed, false);
  });
});

describe('POST /api/messages rate limiting', () => {
  let harness: Harness;
  let supportId: number;
  let designId: number;

  beforeEach(async () => {
    harness = await startHarness({ config: { rateLimit: { limit: 3, windowMs: 10_000 } } });
    ({ supportId, designId } = await seedFixture(harness.store));
  });
  afterEach(() => harness.close());

  const send = (body: string, userId = 1, conversationId = supportId) =>
    postJson(harness, '/api/messages', { conversationId, body }, { userId });

  it('rejects with 429 and a Retry-After once over the limit', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await send(`ok ${i}`)).status, 201);

    const denied = await send('too much');
    assert.equal(denied.status, 429);

    const retryAfter = Number(denied.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After=${retryAfter}`);
    assert.ok(retryAfter <= 10);
  });

  it('does not store the rejected message', async () => {
    for (let i = 0; i < 4; i++) await send(`m${i}`);
    const stored = await harness.store.listMessages(supportId, { limit: 100 });
    assert.equal(stored.length, 3);
  });

  it('throttles the noisy user only', async () => {
    for (let i = 0; i < 3; i++) await send(`flood ${i}`, 1);
    assert.equal((await send('over', 1)).status, 429);

    // Bob is also in this conversation and must be unaffected.
    assert.equal((await send('hello', 2)).status, 201);
  });

  it('is scoped per conversation', async () => {
    for (let i = 0; i < 3; i++) await send(`flood ${i}`, 1, supportId);
    assert.equal((await send('over', 1, supportId)).status, 429);

    assert.equal((await send('elsewhere', 1, designId)).status, 201);
  });

  it('checks membership before spending budget', async () => {
    // A stranger hammering a conversation must not be able to exhaust a
    // participant's allowance for it.
    for (let i = 0; i < 5; i++) {
      assert.equal((await send('let me in', 3)).status, 403);
    }
    assert.equal((await send('legit', 1)).status, 201);
  });
});
