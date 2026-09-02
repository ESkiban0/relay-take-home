# 0013 — `GET /api/messages` returned the entire conversation

**Kind:** bug — performance and stability
**Touches:** `src/routes/messages.ts`, `src/store/*`, `web/app.js`

## Symptom

Opening a busy conversation is slow, and gets slower forever. It never
stabilises, because the cost is proportional to everything ever said in that
room.

## Diagnosis

```js
const [rows] = await pool.query(
  `SELECT id, conversation_id, sender_id, created_at
     FROM messages WHERE conversation_id = ? ORDER BY id ASC`,
  [conversationId],
);
const ids = rows.map((r) => r.id);
const bodies = await mongo().collection('message_bodies').find({ _id: { $in: ids } }).toArray();
```

No `LIMIT`. Every message in the conversation, on every open.

The second query makes it worse: the `$in` is built from *every* id, so a
conversation with 100 000 messages produces a Mongo query with a 100 000-element
array. That is a large query document, and MongoDB has a 16 MB BSON document
limit — a sufficiently long conversation does not merely get slow, it starts
failing outright.

And all of it is buffered in the API process before serialising, so the memory
cost lands on the server, per concurrent request. This is a plausible
out-of-memory path for the whole instance, taking every other user's WebSocket
with it ([0007](0007-multi-instance.md) explains why that matters more once
there are several).

The `ORDER BY id ASC` had no supporting index either — see
[0003](0003-n-plus-one-and-indexes.md).

There was also a smaller shape problem: the endpoint returned a bare array, so
there was nowhere to put a cursor without a breaking change.

## Options

**A. Offset pagination** — `LIMIT ? OFFSET ?`. Familiar, and works with page
numbers. Rejected for two reasons. `OFFSET n` makes the database walk and
discard `n` rows, so deep pages get progressively slower — the exact property
being fixed. And in a stream where new rows arrive constantly, offsets shift
under the reader: a message inserted between requests makes page 2 repeat a row
from page 1.

**B. Cursor (keyset) pagination on `id`.** Chosen. `WHERE id < ? ORDER BY id
DESC LIMIT ?` is an index range scan — the same cost for the thousandth page as
the first — and it is stable under concurrent inserts, because the cursor names
a row rather than a position. `id` is monotonic here, so it is a valid cursor.

**C. Cursor on `created_at`.** Would be needed if ids were not monotonic (UUIDs,
say). Rejected: `created_at` is a `TIMESTAMP` with one-second resolution, so
many messages share a value and a cursor on it either skips or repeats them.
`id` has no such ambiguity.

**D. A hard cap with no paging** — return the newest 50, full stop. Simplest,
and honestly enough for a first pass. Rejected because it makes older messages
permanently unreachable, which turns a performance fix into a data-loss-shaped
feature regression.

## What I did

`Store.listMessages(conversationId, { before, limit })`:

```sql
SELECT ... FROM messages
 WHERE conversation_id = ? AND id < ?
 ORDER BY id DESC
 LIMIT ?
```

Newest-first at the database — so `LIMIT` is cheap and the index does the
ordering — then reversed in the application for display. That pairing with
`idx_messages_conversation_recent (conversation_id, id DESC)` is deliberate:
together they make this a range scan with no filesort.

The response became an object so it could carry the cursor:

```json
{ "messages": [...], "nextBefore": 41 }
```

`nextBefore` is the oldest returned id when a full page came back, and `null`
when the start of the conversation has been reached — so the client has an
unambiguous stop condition rather than having to infer one from a short page.

This is a **breaking change** to the endpoint. It was a bare array; it is now an
object. The frontend is the only consumer and is updated in the same change. In
a deployed API this would need a version or a transitional field, and I would
not have done it silently.

Page size is `MESSAGE_PAGE_SIZE` (default 50).

The client gained a `Load older messages` button that walks the cursor backwards
and preserves scroll position:

```js
const previousHeight = pane.scrollHeight;
for (const m of [...messages].reverse()) pane.prepend(renderMessage(m));
pane.scrollTop = pane.scrollHeight - previousHeight;
```

Without that line, prepending yanks the viewport to the top and the user loses
their place — the classic way to make pagination feel broken even when it works.

## Tests

`test/messages.test.ts` → `GET /api/messages`, against a fixture of 25 messages
with a page size of 10:

- `returns the newest page, oldest-first, capped at the page size` — asserts
  exactly `m16`…`m25`. Pins three things at once: the cap, that it is the
  *newest* page rather than the oldest, and the display order.
- `pages backwards with the returned cursor and stops at the start` — walks the
  cursor to exhaustion and asserts all 25 messages, in order, with
  `new Set(seen).size === 25` proving no page overlap, and that `nextBefore`
  reaches `null` rather than looping. The overlap assertion is the one that
  catches off-by-one errors in the cursor, which is where this kind of code
  actually goes wrong.

The fixture also needed the rate limit raised, which is noted in the test — the
default 5-per-10s would otherwise cap the seed data at five messages.

## Verification

Partly verified. Paging semantics, ordering, the cursor and its termination are
covered against `MemoryStore`.

**The SQL is unrun** — no Docker (see [0000](0000-overview.md)). The specific
thing I would check on a live MySQL is `EXPLAIN` on the paged query showing a
range scan on `idx_messages_conversation_recent` with no `Using filesort`, since
that index is the entire reason the design is `O(page)` rather than
`O(conversation)`.
