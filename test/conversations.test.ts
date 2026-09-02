import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, postJson, seedFixture, startHarness, type Harness } from './helpers.ts';

describe('GET /api/conversations', () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(() => harness.close());

  it('requires a caller identity', async () => {
    const res = await api(harness, '/api/conversations', { userId: null });
    assert.equal(res.status, 401);
  });

  it('rejects a malformed identity rather than coercing it', async () => {
    const res = await api(harness, '/api/conversations', {
      headers: { 'x-user-id': 'not-a-number' },
    });
    assert.equal(res.status, 400);
  });

  it('returns only the conversations the caller participates in', async () => {
    const { supportId, designId } = await seedFixture(harness.store);

    const alice = await api(harness, '/api/conversations', { userId: 1 });
    assert.deepEqual(
      alice.body.map((c: any) => c.id).sort(),
      [supportId, designId].sort(),
    );

    const bob = await api(harness, '/api/conversations', { userId: 2 });
    assert.deepEqual(
      bob.body.map((c: any) => c.id),
      [supportId],
    );
  });

  it('reports message counts and the last message', async () => {
    const fresh = await startHarness();
    try {
      const { supportId } = await seedFixture(fresh.store);
      await postJson(fresh, '/api/messages', { conversationId: supportId, body: 'first' });
      await postJson(fresh, '/api/messages', { conversationId: supportId, body: 'second' });

      const res = await api(fresh, '/api/conversations');
      const support = res.body.find((c: any) => c.id === supportId);
      assert.equal(support.messageCount, 2);
      assert.equal(support.lastMessage.body, 'second');
    } finally {
      await fresh.close();
    }
  });

  it('orders the inbox by most recent activity, not by id', async () => {
    const fresh = await startHarness();
    try {
      const { supportId, designId } = await seedFixture(fresh.store);
      // Newest activity lands in the *lower*-id conversation, so an id-ordered
      // inbox — the original behaviour — would get this backwards.
      await postJson(fresh, '/api/messages', { conversationId: designId, body: 'design' });
      await postJson(fresh, '/api/messages', { conversationId: supportId, body: 'support' });

      const res = await api(fresh, '/api/conversations');
      assert.deepEqual(
        res.body.map((c: any) => c.id),
        [supportId, designId],
      );
    } finally {
      await fresh.close();
    }
  });
});

describe('POST /api/conversations', () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(() => harness.close());

  it('creates a conversation with its participants', async () => {
    const res = await postJson(harness, '/api/conversations', {
      title: 'Launch plan',
      participantIds: [1, 2],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Launch plan');
    assert.deepEqual(res.body.participantIds, [1, 2]);
    assert.equal(await harness.store.isParticipant(res.body.id, 2), true);
  });

  it('rejects a missing or blank title', async () => {
    for (const title of [undefined, '', '   ', 42]) {
      const res = await postJson(harness, '/api/conversations', { title, participantIds: [1] });
      assert.equal(res.status, 400, `title=${JSON.stringify(title)}`);
    }
  });

  it('rejects participant ids that are not positive integers', async () => {
    for (const ids of [[], ['abc'], [0], [-1], [1.5], 'nope']) {
      const res = await postJson(harness, '/api/conversations', { title: 'x', participantIds: ids });
      assert.equal(res.status, 400, `participantIds=${JSON.stringify(ids)}`);
    }
  });

  it('refuses to create a conversation the caller is not in', async () => {
    const res = await postJson(harness, '/api/conversations', {
      title: 'Not mine',
      participantIds: [2, 3],
    });
    assert.equal(res.status, 400);
  });

  it('de-duplicates repeated participant ids', async () => {
    const res = await postJson(harness, '/api/conversations', {
      title: 'Dupes',
      participantIds: [1, 1, 2, 2],
    });
    assert.deepEqual(res.body.participantIds, [1, 2]);
  });
});
