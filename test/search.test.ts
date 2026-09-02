import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, seedFixture, startHarness, type Harness } from './helpers.ts';

/**
 * These exercise the *contract* both Store implementations promise — word-based,
 * case-insensitive matching, scoped to the caller's conversations, newest first.
 * Ranking is deliberately not asserted: Mongo scores by textScore and the
 * in-memory store does not, and pinning that here would make the suite lie
 * about one of them. See docs/0005-search.md.
 */
describe('GET /api/search', () => {
  let harness: Harness;
  let supportId: number;
  let designId: number;

  before(async () => {
    harness = await startHarness();
    ({ supportId, designId } = await seedFixture(harness.store));

    const messages = [
      { conversationId: supportId, senderId: 2, body: 'Hi, any update on order #1042?' },
      { conversationId: supportId, senderId: 1, body: 'Checking now — give me a minute.' },
      { conversationId: supportId, senderId: 1, body: 'Your REFUND has been issued.' },
      { conversationId: designId, senderId: 3, body: 'Notes from the design sync are in the doc.' },
      { conversationId: designId, senderId: 1, body: 'Refunds page needs a design pass.' },
    ];
    for (const m of messages) await harness.store.createMessage({ ...m, clientId: null });
  });
  after(() => harness.close());

  const search = (q: string, userId = 1) =>
    api(harness, `/api/search?q=${encodeURIComponent(q)}`, { userId });

  it('requires a caller identity', async () => {
    const res = await api(harness, '/api/search?q=refund', { userId: null });
    assert.equal(res.status, 401);
  });

  it('returns an empty list for a blank query without touching the store', async () => {
    for (const q of ['', '   ']) {
      const res = await search(q);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, []);
    }
  });

  it('finds messages by word, case-insensitively', async () => {
    const res = await search('REFUND');
    const bodies = res.body.map((h: any) => h.body);
    assert.ok(bodies.some((b: string) => b.includes('REFUND has been issued')));
  });

  it('returns the fields the sidebar renders', async () => {
    const [hit] = (await search('minute')).body;
    assert.equal(hit.conversationId, supportId);
    assert.equal(hit.conversationTitle, 'Support — order #1042');
    assert.equal(typeof hit.body, 'string');
    assert.equal(typeof hit.messageId, 'number');
    assert.equal(hit.senderId, 1);
  });

  it('scopes results to the caller: Carol cannot see the support room', async () => {
    const alice = await search('order', 1);
    assert.ok(alice.body.length > 0);

    // Carol is only in "Design sync"; the same query must not reach her.
    const carol = await search('order', 3);
    assert.deepEqual(carol.body, []);
  });

  it('requires every term to match', async () => {
    assert.ok((await search('design pass')).body.length > 0);
    assert.deepEqual((await search('design bicycle')).body, []);
  });

  it('returns nothing for a term that appears nowhere', async () => {
    assert.deepEqual((await search('kangaroo')).body, []);
  });

  it('caps the number of results', async () => {
    const capped = await startHarness({ config: { searchLimit: 2 } });
    try {
      const { supportId: id } = await seedFixture(capped.store);
      for (let i = 0; i < 10; i++) {
        await capped.store.createMessage({
          conversationId: id,
          senderId: 1,
          body: `needle ${i}`,
          clientId: null,
        });
      }
      const res = await api(capped, '/api/search?q=needle');
      assert.equal(res.body.length, 2);
    } finally {
      await capped.close();
    }
  });
});
