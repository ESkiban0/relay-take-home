# 0003 — The inbox ran 2N+1 queries against unindexed tables

**Kind:** bug — performance
**Touches:** `src/routes/conversations.ts`, `src/store/sql-mongo.ts`, `docker/db/mysql.sql`

## Symptom

Opening the app gets slower the more conversations you are in, and slower again
as the message table grows — even for conversations you never open.

## Diagnosis

`GET /api/conversations` fetched the list, then looped:

```js
for (const c of conversations) {
  const [[last]]    = await pool.query('SELECT ... WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [c.id]);
  const [[counted]] = await pool.query('SELECT COUNT(*) ... WHERE conversation_id = ?', [c.id]);
  result.push({ ...c, lastMessage: last || null, messageCount: counted.count });
}
```

`1 + 2N` queries, each `await`ed in sequence — so N round trips of latency, not
N queries pipelined. At 20 conversations and 1 ms round trips that is 41 ms of
pure waiting before the handler even starts serialising.

The bigger problem is underneath. The schema declared no index on
`messages.conversation_id`:

```sql
CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  ...
);
```

The primary key is on `id`, so **every one of those `2N` queries is a full table
scan.** `COUNT(*) WHERE conversation_id = ?` reads every row in the table to
count a handful. With 1M messages and 20 conversations, one inbox load is 40
full scans. This is the kind of thing that is invisible with seed data and
catastrophic at any real size.

`conversation_participants` had the same shape of problem from the other side.
Its primary key is `(conversation_id, user_id)`, which serves "who is in
conversation X" but *not* "which conversations is user Y in" — a composite index
is only usable from its leftmost column. The inbox query filters on `user_id`,
so it could not use the PK either.

`lastMessage` also returned no `body`: it selected `id, sender_id, created_at`
from MySQL and never joined the Mongo body, so the sidebar had nothing to
preview even if it wanted to.

## Options

**A. Keep the loop, add indexes.** Fixes the scans; leaves `2N` round trips.
Cheap, and genuinely most of the win — but it leaves a loop that will be copied.

**B. One query with a correlated subquery per row.**
```sql
SELECT c.*, (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) ...
```
One round trip, and with the index it is fast. But it recomputes the aggregate
per conversation row, and the shape encourages adding a third and fourth
subquery later.

**C. A single grouped aggregate, joined.** Chosen. One `GROUP BY` over
`messages` gives count and `MAX(id)` for every conversation at once; join it to
the participant-filtered conversations. Then one more query to hydrate the last
messages by id. **Two queries total, independent of N.**

**D. Denormalise** — keep `message_count` and `last_message_id` columns on
`conversations`, updated on write. This is where a busy product ends up: it
makes the inbox a single indexed read with no aggregation. Rejected as premature
here. It adds a write-path invariant to keep correct (and to repair when it
drifts), and option C with the right index is fast well past the size this app
is at. Worth revisiting when the `GROUP BY` over the whole message table becomes
the bottleneck — which it will, since it scans all messages, not just recent
ones.

## What I did

`SqlMongoStore.listConversationsForUser` — two queries:

```sql
SELECT c.id, c.title,
       COALESCE(agg.message_count, 0) AS messageCount,
       agg.last_id AS lastId
  FROM conversations c
  JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ?
  LEFT JOIN (
       SELECT conversation_id, COUNT(*) AS message_count, MAX(id) AS last_id
         FROM messages GROUP BY conversation_id
  ) agg ON agg.conversation_id = c.id
 ORDER BY agg.last_id IS NULL, agg.last_id DESC, c.id DESC
```

then one batched load of those `last_id`s, which also joins the bodies from
Mongo — so `lastMessage` now actually carries the text.

Indexes added in `docker/db/mysql.sql`:

```sql
KEY idx_messages_conversation_recent (conversation_id, id DESC)  -- on messages
KEY idx_participants_user (user_id)                              -- on conversation_participants
```

The first is intended to serve the aggregate and the message-history read
([0013](0013-unbounded-history.md)), which wants exactly "newest N rows of one
conversation" — with `(conversation_id, id DESC)` that is an index scan with no
sort.

> **Measured later, and only partly true.** Running this against MySQL 8 showed
> the optimiser prefers a backward primary-key scan for conversations with
> recent traffic, and only selects this index for large low-activity ones —
> where it is 74x faster. The reasoning above is the case it was built for, not
> the case it is used in most often. See [0016](0016-live-stack-verification.md).

I also added foreign keys and a unique constraint on `users.email`. Neither is a
performance fix; both are the kind of thing that is nearly free to add now and
awkward once there is data violating them.

## A behaviour change that came with it

The old query ordered by `c.id ASC`, so the inbox was in creation order and a
conversation with a new message did not move. Now it orders by most recent
activity. This is a deliberate change, not a side effect — an inbox ordered by
creation date is not an inbox — and it is asserted, because sorting is easy to
get accidentally right in seed data.

## Tests

`test/conversations.test.ts`:

- `reports message counts and the last message` — the aggregate and the body
  hydration.
- `orders the inbox by most recent activity, not by id` — constructed so the
  newest activity lands in the *lower*-id conversation, so the old `ORDER BY
  c.id ASC` would produce the exact opposite order and fail.
- `returns only the conversations the caller participates in` — the join is
  still a filter, not just a lookup.

Query *count* is not asserted. Doing so would mean counting calls on the pool,
which is an assertion about `SqlMongoStore`'s internals and unavailable through
the in-memory store. The right home for that is an `EXPLAIN`-based test against
a real MySQL — see Verification.

## Verification

Verified against MySQL 8 — see [0016](0016-live-stack-verification.md). The
rewritten inbox query runs, ordering by activity is correct, `lastMessage.body`
is populated, and `EXPLAIN` confirms the join uses `idx_participants_user` as a
**covering** index (`type: ref`, `Extra: Using index`).

**One claim in this document was wrong and is corrected there.** I wrote that
the history read would always be a range scan on
`idx_messages_conversation_recent` with no filesort. Measured on ~950k rows, the
optimiser picks the primary key with a backward scan for conversations with
recent traffic — correctly, since it finds 50 matching rows almost immediately.
It selects my index for large *low-activity* conversations, where it is **74x
faster** (1.0 ms vs 74.5 ms) and sorts nothing. The index earns its place, but
in one specific case rather than universally.
