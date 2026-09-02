# 0002 — A 200 000-iteration PBKDF2 on the event loop

**Kind:** bug — performance, and the one that hurts first
**Touches:** `src/services/messages.ts` (deleted), `src/store/sql-mongo.ts`

## Symptom

"A few things don't behave right once you actually use it." With one user
everything is fine. With a handful, the whole app — every request, every
WebSocket frame, the health check — goes gluey whenever anyone sends a message.

## Diagnosis

`createMessage` opened with this:

```ts
const signature = crypto
  .pbkdf2Sync(body, 'relay-signing', 200000, 32, 'sha256')
  .toString('hex');
```

Three separate problems in four lines.

**It blocks the event loop.** `pbkdf2Sync` is synchronous and 200 000 iterations
of SHA-256 is deliberately expensive — that is the entire point of PBKDF2.

Measured on the machine I worked on:

```
19.4 ms per message   (pbkdf2Sync, 200k iterations, as written)
 0.2 ms per message   (HMAC-SHA256, for scale)
```

Node is single-threaded, so that is 19 ms during which the process serves
nobody: not other senders, not the inbox, not a WebSocket frame that was ready
to go out, not the health check. It caps the entire instance at roughly 50
messages per second no matter how much else it has to do, and it adds latency to
every *unrelated* request that happens to queue behind a send. On a smaller
container CPU it is several times worse.

The failure presents as "the app feels slow under load" rather than "this one
function is wrong", which is exactly why it survives.

**It is a password-hashing function being used as a checksum.** PBKDF2 is a *key
derivation function*. Its cost is a feature designed to make brute-forcing a
password expensive. Nothing here is a password.

**Nothing ever reads it.** `signature` is written into the Mongo document and
never selected, never compared, never returned. `grep -r signature src/` finds
the write and nothing else. It cannot detect tampering: it is unkeyed and
unsalted, so anyone who can edit the body can recompute it. It is not a
deduplication key — that is what `client_id` was for
([0009](0009-duplicate-sends.md)). It is pure cost.

## Options

**A. Move it to async `crypto.pbkdf2`.** Frees the event loop, but pushes the
same 19 ms onto the libuv threadpool — four threads by default, shared with
file I/O and DNS. At any real send rate the pool becomes the bottleneck instead.
Still paying a large cost for a value nobody reads.

**B. Keep integrity checking, make it cheap and correct** — `HMAC-SHA256` with a
server-side key — 0.2 ms above, two orders of magnitude cheaper — and actually
a tamper-evident signature. This
is the right answer *if the requirement exists*. But the threat model would have
to be "the Mongo body store is writable by someone we do not trust while the
API's key is not", and there is nothing in the codebase suggesting that. Adding
a key to manage and rotate to satisfy a requirement I invented is worse than not
adding it.

**C. Delete it.** Chosen.

**D. Delete it and open a question instead.** Effectively what I did — the
decision is recorded here, so if signing was meant to be real it comes back as a
deliberate design with a stated threat model, not as a `pbkdf2Sync` call.

## What I did

Removed the computation and the stored field. `src/services/messages.ts` had no
other content once it went, so the file is gone and message creation lives in
the `Store` ([0001](0001-store-abstraction.md)).

If message integrity is a real requirement, the shape I would want is: HMAC over
`(id, conversationId, senderId, body, createdAt)` — not the body alone, or the
signature can be replayed onto a different message — with a key from the
environment, verified on read, and a documented answer to "what do we do when
verification fails". That is a feature with a design, not a line in an insert.

## Tests

There is no test asserting "PBKDF2 is not called" — that is a test of an
implementation detail, and it would pass just as well if the function did
nothing at all.

What the suite does assert is that message creation is correct without it:
`test/messages.test.ts` covers storage, the returned shape, trimming, sender
attribution and idempotency. If signing returns as a real feature, its tests
belong with it.

The cost is better shown than asserted:

```
node -e "const c=require('crypto');const t=Date.now();c.pbkdf2Sync('hi','relay-signing',200000,32,'sha256');console.log(Date.now()-t+'ms of dead event loop, per message')"
```

## Verification

Verified — the suite passes with the call removed, and nothing in the codebase
reads the field it produced.
