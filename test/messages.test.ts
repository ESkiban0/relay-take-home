import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { api, postJson, seedFixture, startHarness, type Harness } from './helpers.ts';

describe('POST /api/messages', () => {
  let harness: Harness;
  let supportId: number;

  beforeEach(async () => {
    harness = await startHarness();
    ({ supportId } = await seedFixture(harness.store));
  });
  afterEach(() => harness.close());

  it('stores and returns the message', async () => {
    const res = await postJson(harness, '/api/messages', {
      conversationId: supportId,
      body: 'hello there',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.body, 'hello there');
    assert.equal(res.body.senderId, 1);
    assert.equal(res.body.conversationId, supportId);
  });

  it('takes the sender from the caller identity, not from the payload', async () => {
    // The old route trusted `senderId` in the body, so anyone could post as
    // anyone. The field is now ignored entirely.
    const res = await postJson(
      harness,
      '/api/messages',
      { conversationId: supportId, body: 'spoofed', senderId: 999 },
      { userId: 2 },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.senderId, 2);
  });

  it('refuses to post into a conversation the caller is not in', async () => {
    const res = await postJson(
      harness,
      '/api/messages',
      { conversationId: supportId, body: 'let me in' },
      { userId: 3 },
    );
    assert.equal(res.status, 403);
  });

  it('validates the payload', async () => {
    const cases: Array<Record<string, unknown>> = [
      { body: 'no conversation' },
      { conversationId: supportId },
      { conversationId: supportId, body: '' },
      { conversationId: supportId, body: '    ' },
      { conversationId: supportId, body: 123 },
      { conversationId: 'abc', body: 'ok' },
      { conversationId: supportId, body: 'x'.repeat(4001) },
    ];
    for (const payload of cases) {
      const res = await postJson(harness, '/api/messages', payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
    }
  });

  it('trims the body', async () => {
    const res = await postJson(harness, '/api/messages', {
      conversationId: supportId,
      body: '   padded   ',
    });
    assert.equal(res.body.body, 'padded');
  });

  describe('idempotency', () => {
    it('collapses a repeated clientId into a single message', async () => {
      const payload = {
        conversationId: supportId,
        body: 'double clicked',
        clientId: 'client-abc',
      };

      const first = await postJson(harness, '/api/messages', payload);
      const second = await postJson(harness, '/api/messages', payload);

      assert.equal(first.status, 201);
      // 200, not 201: nothing was created the second time.
      assert.equal(second.status, 200);
      assert.equal(second.body.id, first.body.id);

      const list = await api(harness, `/api/messages?conversationId=${supportId}`);
      assert.equal(list.body.messages.length, 1);
    });

    it('does not broadcast a de-duplicated send twice', async () => {
      const seen: any[] = [];
      harness.broker.subscribe((event) => seen.push(event));

      const payload = { conversationId: supportId, body: 'once', clientId: 'client-xyz' };
      await postJson(harness, '/api/messages', payload);
      await postJson(harness, '/api/messages', payload);

      assert.equal(seen.length, 1);
    });

    it('keeps clientIds scoped per sender', async () => {
      const clientId = 'shared-id';
      const alice = await postJson(harness, '/api/messages', {
        conversationId: supportId,
        body: 'from alice',
        clientId,
      });
      const bob = await postJson(
        harness,
        '/api/messages',
        { conversationId: supportId, body: 'from bob', clientId },
        { userId: 2 },
      );

      assert.equal(bob.status, 201);
      assert.notEqual(bob.body.id, alice.body.id);
    });

    it('treats sends without a clientId as distinct', async () => {
      await postJson(harness, '/api/messages', { conversationId: supportId, body: 'same text' });
      await postJson(harness, '/api/messages', { conversationId: supportId, body: 'same text' });

      const list = await api(harness, `/api/messages?conversationId=${supportId}`);
      assert.equal(list.body.messages.length, 2);
    });
  });
});

describe('GET /api/messages', () => {
  let harness: Harness;
  let supportId: number;

  before(async () => {
    harness = await startHarness({
      // Rate limiting is exercised in rate-limit.test.ts; here it would just cap
      // the fixture at five messages.
      config: { messagePageSize: 10, rateLimit: { limit: 1000, windowMs: 10_000 } },
    });
    ({ supportId } = await seedFixture(harness.store));
    for (let i = 1; i <= 25; i++) {
      await postJson(harness, '/api/messages', { conversationId: supportId, body: `m${i}` });
    }
  });
  after(() => harness.close());

  it('refuses conversations the caller is not in', async () => {
    const res = await api(harness, `/api/messages?conversationId=${supportId}`, { userId: 3 });
    assert.equal(res.status, 403);
  });

  it('requires a conversationId', async () => {
    assert.equal((await api(harness, '/api/messages')).status, 400);
    assert.equal((await api(harness, '/api/messages?conversationId=abc')).status, 400);
  });

  it('returns the newest page, oldest-first, capped at the page size', async () => {
    const res = await api(harness, `/api/messages?conversationId=${supportId}`);
    assert.equal(res.body.messages.length, 10);
    assert.deepEqual(
      res.body.messages.map((m: any) => m.body),
      ['m16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25'],
    );
  });

  it('pages backwards with the returned cursor and stops at the start', async () => {
    const seen: string[] = [];
    let before: number | null = null;

    for (let page = 0; page < 5; page++) {
      const query = before === null ? '' : `&before=${before}`;
      const res: any = await api(harness, `/api/messages?conversationId=${supportId}${query}`);
      seen.unshift(...res.body.messages.map((m: any) => m.body));
      before = res.body.nextBefore;
      if (before === null) break;
    }

    assert.equal(before, null, 'paging terminates');
    assert.equal(seen.length, 25);
    assert.equal(seen[0], 'm1');
    assert.equal(seen.at(-1), 'm25');
    assert.equal(new Set(seen).size, 25, 'no page overlap');
  });
});
