# 0014 — A failed Mongo write left a permanently empty message

**Kind:** bug — data integrity
**Touches:** `src/store/sql-mongo.ts`, `src/routes/messages.ts`

## Symptom

Occasional blank messages in the history — right sender, right timestamp, no
text. They never repair themselves. Nobody can explain them, because by the time
anyone looks, the failure that caused them is long over.

## Diagnosis

A message is written to two databases:

```ts
const [res] = await pool.execute('INSERT INTO messages ...');   // MySQL: metadata
const id = res.insertId;

await mongo().collection('message_bodies').insertOne({ _id: id, body, ... });  // Mongo: body
```

Two stores, no transaction spanning them — there cannot be one. If the second
write fails, the first has already committed. The result is a message row with
no body.

The read path then silently papers over it:

```js
res.json(rows.map((r) => ({ ...r, body: bodyById.get(r.id) ?? '' })));
```

`?? ''`. A missing body renders as an empty string, indistinguishable from a
message whose text really is empty. The corruption is permanent and invisible:
no error is logged, nothing is retried, and the row will sit there being wrong
for as long as the conversation exists.

The caller is also misled — the `POST` returns a 500, so the client believes the
send failed, while a phantom message is in the conversation forever.

This is the standard failure mode of writing to two stores in sequence, and it
is worth saying that the deepest fix is not to be in this position: the split of
metadata and bodies across MySQL and Mongo buys very little here and costs a
join on every read plus this bug. [0005](0005-search.md) discusses consolidating
them. That is a data migration, not a bug fix, so it is out of scope here.

## Options

**A. Leave it; `?? ''`.** Status quo. Silent permanent corruption. No.

**B. Write Mongo first, then MySQL.** Inverts the problem: an orphaned body with
no metadata. Slightly better in that the orphan is invisible to readers rather
than being a visible blank message — but it needs the MySQL id as `_id`, so it
would require generating ids in the application, which is a bigger change than
the bug warrants. And it leaks garbage rather than fixing anything.

**C. Two-phase commit / a distributed transaction coordinator.** Correct in
theory, wildly disproportionate, and MongoDB and MySQL do not participate in a
common protocol anyway.

**D. Outbox pattern with a background reconciler** — write MySQL plus an intent
record in one transaction, have a worker complete the Mongo write and retry
until it succeeds. This is the genuinely correct answer for a system that must
not lose messages: it converts an atomicity problem into a retry problem.
Rejected here because it needs a worker process, a retry policy, poison-message
handling and monitoring — a piece of infrastructure, in an app that currently
has no background jobs at all.

**E. A compensating delete.** Chosen. If the Mongo write fails, delete the MySQL
row and propagate the error, so the operation as a whole fails cleanly.

## What I did

```ts
try {
  await this.bodies.insertOne({ _id: id, conversationId, senderId, body, createdAt });
} catch (err) {
  await this.pool.execute('DELETE FROM messages WHERE id = ?', [id]).catch(() => {
    /* best effort; the rethrow below is what the caller acts on */
  });
  throw err;
}
```

The result is a send that either fully succeeds or fully fails. The client gets
its 500 and can retry — safely, because the retry carries the same `clientId`
([0009](0009-duplicate-sends.md)), so a compensation that *did* succeed does not
turn into a duplicate on the second attempt. The two fixes support each other.

The broadcast is already after the write ([0007](0007-multi-instance.md)), so a
failed send never announces a message that does not exist.

### What this does not fix, stated plainly

**The compensating delete can itself fail.** If MySQL is unreachable at that
moment, the orphan row remains — and now with no error path left to take. This
narrows the window from "any Mongo failure" to "a Mongo failure *and* a MySQL
failure in the same operation", which is a large improvement and not a
guarantee. The `.catch()` is deliberate: a failed cleanup must not mask the
original error, which is the thing the caller needs to see.

Being precise about it: this is best-effort compensation, not atomicity. Option
D is what atomicity would cost. The right way to close the remaining gap without
building a worker is a periodic reconciliation job — find `messages` rows with
no corresponding body older than a few minutes, log them, and delete or repair
— which is roughly twenty lines and a cron entry. I would add that before
relying on this in production.

**`?? ''` is still there** in `SqlMongoStore.loadMessages`, because rows
orphaned by the old code may already exist and a read path that throws on them
would break the conversation entirely. It should be paired with a warning log so
the condition is observable rather than silent — that is a small thing I would
add next, and the reason I am listing it rather than quietly leaving it.

## Tests

**Not covered by an automated test**, and I would rather say so than imply
otherwise.

The reason is structural: the bug exists only in `SqlMongoStore`, in the seam
between two real databases. `MemoryStore` has no such seam — there is one data
structure and nothing to be inconsistent with — so the in-memory suite cannot
express the failure at all. Testing it needs a real MySQL and a real Mongo, with
the Mongo write made to fail on demand.

The test I would write, given Docker:

1. Point `SqlMongoStore` at live MySQL and Mongo.
2. Stub `bodies.insertOne` to throw.
3. `createMessage(...)` and assert it rejects.
4. Assert `SELECT COUNT(*) FROM messages WHERE id = ?` is `0` — the
   compensation ran and no orphan remains.
5. Restore, resend with the same `clientId`, assert exactly one message exists.

Step 5 is the interesting one: it is where this change and
[0009](0009-duplicate-sends.md) have to work together, and where a naive
compensation would produce a duplicate.

## Verification

**Not verified.** This change is entirely inside the unrun `SqlMongoStore`. It
typechecks and the logic is straightforward, but no part of it has executed
against a real database, and it is the change in this set with the weakest
evidence behind it. See [0000](0000-overview.md) for why, and the test sketch
above for exactly what I would run first.
