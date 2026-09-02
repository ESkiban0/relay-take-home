# Overview — what I changed and why

This folder is the working record. There is one document per change: what was
wrong (or what was being built), what the options were, why I picked the one I
picked, and how it is tested.

Numbering is chronological — the order I worked in — so the sequence mixes bug
fixes with features. The grouping below is the useful way to read it.

## Start here

| # | Document | Kind |
|---|---|---|
| [0001](0001-store-abstraction.md) | Store / Broker / RateLimiter behind interfaces | Structure |
| [0002](0002-blocking-signature.md) | 200k-iteration PBKDF2 on the event loop | Bug |
| [0003](0003-n-plus-one-and-indexes.md) | 2N+1 queries for the inbox, no usable indexes | Bug |
| [0004](0004-async-error-handling.md) | Rejected async handlers left requests hanging | Bug |
| [0005](0005-search.md) | `GET /api/search` | Feature — `tasks/search.md` |
| [0006](0006-rate-limiting.md) | 5 sends / 10s per user per conversation | Feature — `tasks/rate-limiting.md` |
| [0007](0007-multi-instance.md) | Real-time survives `--scale api=3` | Feature — `tasks/multi-instance.md` |
| [0008](0008-typing-indicator.md) | Typing indicator | Feature — `tasks/typing-indicator.md` |
| [0009](0009-duplicate-sends.md) | `client_id` existed but nothing de-duplicated | Bug |
| [0010](0010-authorization.md) | Any socket could subscribe to any conversation | Bug |
| [0011](0011-xss-in-sidebar.md) | Conversation titles rendered via `innerHTML` | Bug |
| [0012](0012-websocket-reconnect.md) | A dropped socket silently ended all live updates | Bug |
| [0013](0013-unbounded-history.md) | `GET /api/messages` returned the whole conversation | Bug |
| [0014](0014-cross-store-consistency.md) | A failed Mongo write left a permanently empty message | Bug |

## The short version

**Bugs.** The one that bites first under load is [0002](0002-blocking-signature.md):
every send ran a 200 000-iteration PBKDF2 *synchronously*, so a single message
stalled the entire process for ~100 ms — every other request, every WebSocket
frame, all of it. The signature it computed was never read by anything.
Alongside that, the inbox ran `2N+1` queries against tables with no supporting
index ([0003](0003-n-plus-one-and-indexes.md)), and async route handlers had no
error path at all, so any database blip left the caller waiting for a response
that would never come ([0004](0004-async-error-handling.md)).

Then a cluster of correctness problems that show up "once there's real traffic",
which is how the README puts it: retried sends duplicating messages
([0009](0009-duplicate-sends.md)), sockets able to subscribe to conversations
they were not in ([0010](0010-authorization.md)), conversation titles executing
as HTML ([0011](0011-xss-in-sidebar.md)), a dead socket never reconnecting
([0012](0012-websocket-reconnect.md)), unbounded history responses
([0013](0013-unbounded-history.md)), and a Mongo failure leaving a message row
whose body would render as an empty string forever
([0014](0014-cross-store-consistency.md)).

**Features.** All four from `tasks/`. Search, rate limiting, multi-instance
real-time, and the typing indicator. Rate limiting and multi-instance share the
same piece of infrastructure — Redis — because both need state that outlives a
single process.

**Structure.** One deliberate refactor ([0001](0001-store-abstraction.md)):
data access moved behind a `Store` interface, and pub/sub and rate limiting
behind `Broker` and `RateLimiter`. Routes no longer import a connection pool.
This is what makes the 57-case test suite possible without Docker, and it is
what made the N+1 fix a single method rather than surgery on a handler.

## Running it

```bash
cp .env.example .env
docker compose up --build          # http://localhost:3000
docker compose up -d --scale api=3 # the multi-instance case
```

Without Docker — no MySQL, Mongo or Redis needed:

```bash
npm install
npm run dev:memory                 # http://localhost:3000, demo data seeded
npm test
npm run typecheck
```

## Verification status — read this

I did not have Docker available on the machine I worked on: it is a Hyper-V
guest without nested virtualisation, so Docker Desktop, WSL2 and a local Docker
Engine are all unavailable. That is a real limitation of this submission and I
would rather state it than let it be discovered.

**Verified.** The 57-case suite in `test/` runs the real Express app and the
real WebSocket hub over loopback HTTP and real sockets, against the in-memory
`Store` and `Broker`. That covers every route, every validation and
authorisation rule, the rate-limiting algorithm and its HTTP surface, search
semantics, the typing indicator, and the multi-instance property — the last one
by running two complete app instances over one shared broker, which is the
shape `--scale api=3` produces.

**Not verified against live infrastructure.** The `SqlMongoStore`, `RedisBroker`
and `RedisRateLimiter` implementations, the new MySQL DDL (indexes, the unique
key on `client_id`, the foreign keys), the Mongo text index, and the Envoy
scale-out itself. They are written to the same contract the in-memory
implementations are tested against, and the contract is stated in each document,
but the SQL and Lua have not executed. Each document's "Verification" section
says exactly which side of this line it falls on.
