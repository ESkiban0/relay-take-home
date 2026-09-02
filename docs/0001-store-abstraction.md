# 0001 — Data access behind interfaces

**Kind:** structural change
**Touches:** `src/store/*`, `src/infra/*`, `src/app.ts`, `src/server.ts`, all routes

## What was there

Routes imported infrastructure directly:

```js
// src/routes/conversations.js
import { pool } from '../db/mysql.ts';
```

and `src/db/mysql.ts` created that pool *at import time*:

```ts
export const pool = mysql.createPool(config.mysqlUrl);
```

So importing any route opened a MySQL pool as a side effect. `mongo()` did the
same through a module-level `let db`, throwing `'mongo not connected'` unless a
global `connectMongo()` had run first. `src/index.ts` was both the composition
root and the entry point, and `broadcast()` reached into a module-level `Set` of
sockets.

Three consequences, in increasing order of how much they cost:

1. **Nothing could be tested.** There is no way to exercise a route without a
   live MySQL and Mongo. That is the reason the repo arrived with no tests, and
   the reason the bugs in the rest of these documents survived.
2. **SQL was scattered across handlers**, which is why the inbox N+1
   ([0003](0003-n-plus-one-and-indexes.md)) reads as normal code in situ — the
   loop and the query are in different mental frames when they sit in the same
   function.
3. **The real-time path had no seam**, so making it work across instances
   ([0007](0007-multi-instance.md)) had nowhere to go.

The README explicitly invites this kind of change ("the structure, the types,
bits of plumbing that aren't there"), so I took it — but only as far as it pays
for itself.

## Options

**A. Leave it; test through Docker with testcontainers.** Highest fidelity: the
tests would run the actual SQL. Rejected for two reasons. The practical one is
that I had no Docker (see [0000](0000-overview.md)). The design one is that it
does not address (2) or (3) — the SQL stays scattered and the real-time path
still has no seam — so it buys test coverage and no structure.

**B. Repository per aggregate** — `ConversationRepository`, `MessageRepository`,
`SearchRepository`. More conventional at scale. Rejected because the interesting
operations here span both stores at once: `createMessage` writes MySQL *and*
Mongo, `searchMessages` reads Mongo then MySQL. Splitting them by aggregate puts
the cross-store coordination either in a service layer above the repositories —
another layer for four endpoints — or, worse, back in the handlers.

**C. One `Store` interface, two implementations.** Chosen.

**D. Full hexagonal architecture / DI container.** Rejected as disproportionate.
Four endpoints do not need a container; `createApp({ store, broker, ... })` is a
constructor call.

## What I did

`src/store/types.ts` declares the contract. Two implementations satisfy it:

- `SqlMongoStore` — MySQL for metadata, Mongo for bodies. The production path.
- `MemoryStore` — plain data structures. Backs the test suite and
  `npm run dev:memory`.

Two more interfaces cover the stateful infrastructure, each with the same
two-implementation pattern:

- `Broker` (`src/infra/broker.ts`) — real-time fan-out. `RedisBroker` /
  `MemoryBroker`.
- `RateLimiter` (`src/infra/rate-limit.ts`) — `RedisRateLimiter` /
  `MemoryRateLimiter`.

`createApp()` takes all three as arguments and returns an Express app without
listening. `startServer()` wires the graph; `index.ts` only adds signal
handling. Selection is one environment variable each (`STORE_DRIVER`,
`BROKER_DRIVER`), defaulting to the real thing — the in-memory path is never
what you get by accident.

## The part worth being careful about

Two implementations of one interface can silently disagree, and then the tests
assert something the production path does not do. This is the real cost of the
approach and I want it on the record rather than glossed over.

What I did about it:

- **The contract is behavioural, not incidental.** `types.ts` states ordering,
  de-duplication and scoping rules as documented promises. `MemoryStore` is
  written to *those*, not to whatever fell out of the SQL.
- **Tests assert the contract, never the implementation.** Search asserts
  matching and scoping, not ranking — Mongo ranks by `textScore` and the
  in-memory store cannot, so pinning ranking would make the suite lie about one
  of them ([0005](0005-search.md) covers this).
- **Where an invariant belongs to the database, it lives in the database.**
  Send idempotency is a unique key in MySQL, not application logic that both
  implementations reimplement ([0009](0009-duplicate-sends.md)).
- **It is still a gap.** The honest closing move is a shared conformance suite
  run against both implementations, with the SQL one pointed at a real MySQL in
  CI. I would write that next; without Docker I could not run half of it, and a
  suite that only ever runs against the in-memory side is worse than none
  because it looks like coverage.

## Tests

The whole suite depends on this change; it is what `test/helpers.ts`
(`startHarness`) is built on. Directly relevant:

- `test/http-errors.test.ts` swaps in an `ExplodingStore` subclass to drive the
  failure path of a route — only possible because the store is an argument.
- `test/realtime.test.ts` → `multiple API instances` constructs two complete
  apps over one shared `Store` and `Broker`, which is the seam this change
  created.

## Verification

`MemoryStore`, `MemoryBroker` and `MemoryRateLimiter` are covered by all 64
tests. `SqlMongoStore`, `RedisBroker` and `RedisRateLimiter` typecheck and are
written against the documented contract, but have not run against live MySQL,
Mongo or Redis.
