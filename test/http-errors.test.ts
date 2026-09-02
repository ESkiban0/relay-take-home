import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, seedFixture, startHarness, type Harness } from './helpers.ts';
import { MemoryStore } from '../src/store/memory.ts';

/** A store whose reads blow up, to drive the failure path of the routes. */
class ExplodingStore extends MemoryStore {
  override async listConversationsForUser(): Promise<never> {
    throw new Error('database is on fire');
  }
}

describe('error handling', () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness({ store: new ExplodingStore() });
  });
  after(() => harness.close());

  it('answers 500 instead of hanging when a handler rejects', async () => {
    // Express 4 does not catch rejected promises from async handlers: before
    // asyncHandler this request was never answered at all and the client sat
    // there until it timed out.
    const res = await Promise.race([
      api(harness, '/api/conversations'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('request hung — the rejection was not handled')), 2000),
      ),
    ]);

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'internal error' });
  });

  it('does not leak the internal message to the client', async () => {
    const res = await api(harness, '/api/conversations');
    assert.ok(!JSON.stringify(res.body).includes('on fire'));
  });
});

describe('routing', () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
    await seedFixture(harness.store);
  });
  after(() => harness.close());

  it('answers /healthz', async () => {
    const res = await api(harness, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('returns JSON 404 for unknown API paths rather than the static handler', async () => {
    const res = await api(harness, '/api/nope');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'not found' });
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const res = await api(harness, '/api/messages', { method: 'POST', body: '{ not json' });
    assert.equal(res.status, 400);
  });
});
