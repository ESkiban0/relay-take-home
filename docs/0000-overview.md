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
| [0015](0015-manual-verification.md) | What I checked by hand in a browser, and what it found | Record |
| [0016](0016-live-stack-verification.md) | The live Docker stack: MySQL, Mongo, Redis, `--scale api=3` | Record |

## The short version

**Bugs.** The one that bites first under load is [0002](0002-blocking-signature.md):
every send ran a 200 000-iteration PBKDF2 *synchronously* — measured at 19 ms per
message, during which the process serves nobody: no other request, no WebSocket
frame, not even the health check. The signature it computed was never read by anything.
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
This is what makes the 64-case test suite possible without Docker, and it is
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

I could not run Docker on the machine I started on — a Hyper-V guest without
nested virtualisation, so Docker Desktop, WSL2 and a local Docker Engine were
all unavailable. Most of this work was therefore done and tested without it. I
later ran the full stack in a GitHub Codespace; what that changed is at the end
of this section.

**Verified — automated.** The 64-case suite in `test/` runs the real Express app
and the real WebSocket hub over loopback HTTP and real sockets, against the
in-memory `Store` and `Broker`. That covers every route, every validation and
authorisation rule, the rate-limiting algorithm and its HTTP surface, search
semantics, the typing indicator, and the multi-instance property — the last one
by running two complete app instances over one shared broker, which is the shape
`--scale api=3` produces. `test/web-render.test.ts` renders the real frontend in
jsdom.

**Verified — by hand.** The `memory` drivers mean the app runs with no external
services, so I also ran it and drove the real UI in a browser: two users, live
messages, the unread dot, the typing indicator, rate-limit `429`s, search
scoping, the XSS payload, and a server kill/restart to watch the client
reconnect and catch up. That session is logged in
[0015](0015-manual-verification.md) — it found one bug the test suite could not
see (the inbox stopped re-sorting live), which is now fixed.

**Verified — against the live stack.** I later got Docker working in a GitHub
Codespace and ran the real `docker compose` stack: MySQL 8, MongoDB 7, Redis 7,
Envoy, and `--scale api=3`. That closes the gap above — the SQL, the DDL and its
indexes, the Mongo text index, the Redis Lua script and the three-instance
topology have all now executed. See
[0016](0016-live-stack-verification.md), which also records **a claim of mine
that turned out to be wrong** (which index the optimiser actually picks for
paged history) and **a check that passed for the wrong reason** until I looked
at it.

**Still not verified.** An induced Mongo failure to exercise the compensating
delete in [0014](0014-cross-store-consistency.md) — the weakest-evidence change
in this set; Redis restarting under load; Envoy WebSocket idle-timeout
reconnection; and the rate limiter under genuinely concurrent load. Each
document's "Verification" section says exactly where it stands.
