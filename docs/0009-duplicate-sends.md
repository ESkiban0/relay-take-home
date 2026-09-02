# 0009 — `client_id` existed, but nothing de-duplicated

**Kind:** bug — correctness
**Touches:** `docker/db/mysql.sql`, `src/store/*`, `src/routes/messages.ts`, `web/app.js`

## Symptom

Double-click Send and the message appears twice. Send on a flaky connection, hit
retry, and it appears twice. The README's "nothing stops someone hammering the
send button" is usually read as a rate-limiting problem
([0006](0006-rate-limiting.md)) — but rate limiting caps *volume*, it does not
make a retried send safe. These are two different bugs and they need two
different fixes.

## Diagnosis

The plumbing for this was already half-built. The schema had the column:

```sql
client_id VARCHAR(64) NULL,
```

the frontend generated a value:

```js
clientId: crypto.randomUUID(),
```

and the insert stored it:

```js
'INSERT INTO messages (conversation_id, sender_id, client_id) VALUES (?, ?, ?)'
```

...and nothing ever read it back. No unique constraint, no lookup, no check.
Every `POST` inserted unconditionally. The column was a note-to-self about an
intention that was never finished — which is why it is easy to miss in review:
the code *looks* like it handles idempotency.

There was a second, subtler half. The client generated a **fresh** UUID inside
the submit handler on every send, so even a correct server-side check would
never have matched: a retry of the same message carried a different id. An
idempotency key has to be stable for the operation it identifies, not for the
attempt.

## Options

**A. Application-level check-then-insert.** `SELECT` by `clientId`, insert if
absent. Rejected: it is a textbook race. Two concurrent requests both `SELECT`,
both find nothing, both insert. A double-click produces requests milliseconds
apart — this is the common case, not an edge case. It also costs an extra round
trip on every send to defend against something rare.

**B. Content-based deduplication** — reject an identical body from the same
sender within N seconds. Rejected: it is a guess about intent, and it is wrong
both ways. "ok" twice in a row is legitimate and would be silently swallowed;
two different retries of different messages are not caught. Never infer identity
from content when the client can state it.

**C. A unique constraint in the database.** Chosen. The database is the only
place where "at most one of these exists" can be enforced under concurrency,
because it is the only component that sees all writers.

**D. Idempotency keys in Redis**, as a general HTTP layer. The right shape for
an API with many mutating endpoints, and it also caches the original response.
Rejected as disproportionate for one endpoint, and it would put the invariant in
a store that can evict it.

## What I did

The constraint:

```sql
UNIQUE KEY uniq_messages_client (conversation_id, sender_id, client_id)
```

Three properties worth noting:

- **`sender_id` is in the key.** Without it, two users whose clients happen to
  generate the same id would collide, and one would have their message silently
  attributed to the other's. Scoped per sender, a collision is impossible to
  exploit.
- **`NULL`s do not collide in MySQL.** A client that sends no `clientId` is
  entirely unaffected — many rows can have `client_id IS NULL`. This is what
  makes the constraint safe to add to a table with existing data.
- It is the same index shape a lookup would want, so the enforcement is free.

The insert path attempts the write and handles the collision:

```ts
if ((err as { code?: string }).code === 'ER_DUP_ENTRY' && input.clientId !== null) {
  const existing = await this.findByClientId(input);
  if (existing) return { message: existing, deduplicated: true };
}
```

Insert-first rather than check-first: the happy path costs one statement, and
correctness comes from the database rather than from timing.

### The response, and the broadcast

A de-duplicated send returns **`200` with the original message**, not `201` and
not an error. The caller asked for this message to exist; it exists; that is
success. Returning `409` would force every client to special-case a situation it
cannot distinguish from success.

More importantly, a de-duplicated send **does not broadcast**:

```ts
if (!deduplicated) {
  await broker.publish({ conversationId, payload: { type: 'message', ...message } });
}
```

Without that check the fix would be half a fix — the second insert is suppressed
but every open window still paints a second copy, which is the symptom the user
actually reported.

### The client half

`web/app.js` now also de-duplicates on render by `data-message-id`, because a
reconnect ([0012](0012-websocket-reconnect.md)) can legitimately replay a frame
for a message already on screen. Server-side idempotency and client-side render
idempotency are different problems; both are needed.

## Tests

`test/messages.test.ts` → `idempotency`:

- `collapses a repeated clientId into a single message` — second call returns
  `200` with the *same id*, and the conversation holds one message.
- `does not broadcast a de-duplicated send twice` — subscribes to the broker and
  asserts exactly one event. This is the half that is easy to forget.
- `keeps clientIds scoped per sender` — Alice and Bob send the same `clientId`;
  both succeed with different ids.
- `treats sends without a clientId as distinct` — two identical bodies with no
  key produce two messages. Pins that this is idempotency, not content
  deduplication (option B).

## Verification

Partly verified. The behaviour is covered against `MemoryStore`, which
implements the same `(conversationId, senderId, clientId)` rule, and confirmed
by hand against the running app — the same `clientId` posted twice returned
`201` then `200` with an identical id ([0015](0015-manual-verification.md)).

**The MySQL side is unrun**: the `UNIQUE KEY`, and specifically the
`ER_DUP_ENTRY` catch. Two things I would want to confirm on a live MySQL: that
`NULL` client ids genuinely do not collide (they should — MySQL treats `NULL` as
distinct in unique indexes, but it is worth seeing), and that the error `code` is
`ER_DUP_ENTRY` as `mysql2` surfaces it. The in-memory store cannot exercise
either, since it has no constraint to violate.
