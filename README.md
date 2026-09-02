# Relay

A small chat / inbox app. This is my worked copy of the take-home — the original
brief is preserved at the bottom.

**The full write-up is in [`docs/`](docs/), one document per change, explaining
what was wrong, what the alternatives were, why I chose what I chose, and how it
is tested. Start with [`docs/0000-overview.md`](docs/0000-overview.md).**

## Running it

```bash
cp .env.example .env
docker compose up --build            # http://localhost:3000
docker compose up -d --scale api=3   # the multi-instance case
```

Or with no MySQL, Mongo or Redis at all — the store and broker have in-memory
implementations:

```bash
npm install
npm run dev:memory                   # http://localhost:3000, demo data seeded
npm test                             # 64 tests
npm run typecheck
```

Open `http://localhost:3000/?userId=2` in a second window to act as another
user.

## What I changed

### Bugs found and fixed

| | What was wrong |
|---|---|
| [0002](docs/0002-blocking-signature.md) | Every send ran a 200 000-iteration `pbkdf2Sync` — **19 ms of blocked event loop per message**, measured — to compute a signature nothing ever read. |
| [0003](docs/0003-n-plus-one-and-indexes.md) | The inbox ran `2N+1` sequential queries, against a `messages` table with **no index on `conversation_id`** — so every one was a full table scan. |
| [0004](docs/0004-async-error-handling.md) | Express 4 does not catch rejected async handlers: any database blip left the request **hanging forever** with no response. |
| [0009](docs/0009-duplicate-sends.md) | `client_id` was stored but never read, and the client generated a fresh UUID per attempt — retries and double-clicks duplicated messages. |
| [0010](docs/0010-authorization.md) | **Any socket could subscribe to any conversation**, `GET /api/messages` had no membership check, and `senderId` came from the request body. |
| [0011](docs/0011-xss-in-sidebar.md) | Conversation titles were rendered with `innerHTML` — stored XSS, executing for every participant. |
| [0012](docs/0012-websocket-reconnect.md) | A dropped WebSocket was never noticed or reopened: the app silently stopped updating and looked fine. |
| [0013](docs/0013-unbounded-history.md) | `GET /api/messages` returned the **entire** conversation, and built a Mongo `$in` from every id. |
| [0014](docs/0014-cross-store-consistency.md) | A failed Mongo write left a MySQL row whose body rendered as `''` forever, silently. |

### Features built — all four from `tasks/`

- **[Search](docs/0005-search.md)** — Mongo text index, scoped to the caller's own conversations in the query itself.
- **[Rate limiting](docs/0006-rate-limiting.md)** — 5 sends / 10 s per user per conversation, sliding-window log in Redis via an atomic Lua script, `429` + `Retry-After`.
- **[Multi-instance](docs/0007-multi-instance.md)** — Redis pub/sub fan-out, so real-time survives `--scale api=3`.
- **[Typing indicator](docs/0008-typing-indicator.md)** — expiry-based rather than start/stop, so a lost "stop" cannot leave it stuck.

### Structure

One refactor ([0001](docs/0001-store-abstraction.md)): data access behind a
`Store` interface, pub/sub and rate limiting behind `Broker` and `RateLimiter`,
each with a real and an in-memory implementation. Routes no longer import a
connection pool. That is what makes the test suite possible and what made the
N+1 fix a single method.

## Honest status

Verified three ways, in increasing order of fidelity:

1. **64 automated tests** against the real Express app and real WebSockets,
   including two full app instances over a shared broker; plus the frontend
   rendered in jsdom.
2. **A hands-on browser session** ([0015](docs/0015-manual-verification.md)) —
   two users, live messages, unread dot, typing indicator, `429`s, search
   scoping, the XSS payload, and a server kill/restart to watch the client
   reconnect and catch up.
3. **The real Docker stack** ([0016](docs/0016-live-stack-verification.md)) —
   MySQL 8, MongoDB 7, Redis 7, Envoy, and `docker compose up -d --scale api=3`.
   The DDL and its indexes, the `ER_DUP_ENTRY` path, the Mongo text index, the
   Redis Lua script and three-instance real-time all executed.

Two findings from doing this rather than reasoning about it, both written up:

- **A claim of mine was wrong.** I documented that the paged history read would
  use `idx_messages_conversation_recent`. Measured on ~950k rows, the optimiser
  prefers a backward primary-key scan for active conversations and only picks my
  index for large archived ones — where it *is* worth it, at 74× (1.0 ms vs
  74.5 ms). Corrected in [0003](docs/0003-n-plus-one-and-indexes.md) and
  [0016](docs/0016-live-stack-verification.md).
- **A check passed for the wrong reason.** The multi-instance rate-limit
  assertion probed as a non-participant, so every request was rejected `403`
  before the limiter ran — and it reported green. Fixed; the real run gives 5 of
  10 accepted across three instances, where a per-process counter would allow 15.

4. **A deliberate bug hunt** ([0017](docs/0017-bug-hunt.md)) against that stack —
   inducing Mongo and Redis outages, killing instances, flooding sockets,
   probing signal handling. It closed the remaining gaps and **found fourteen
   more bugs**, three of them introduced by me.

The one worth singling out: fail-fast Redis options I added while fixing an
indefinite hang were also applied to the *subscriber* connection, whose
`SUBSCRIBE` is issued before the socket is ready. It was rejected outright, and
every instance went permanently deaf — **all cross-instance real-time silently
dead, with all 70 tests still green**, because they run against `MemoryBroker`
and never construct a `RedisBroker`. That is the two-implementations risk from
[0001](docs/0001-store-abstraction.md), demonstrated rather than hypothesised.

Of the twelve issues fixed in that pass, the test suite would have caught none:
they live in driver defaults, signal handling, process supervision and proxy
behaviour.

**Still open**, and listed as such: Envoy has no health checks or retry policy,
so a dying instance produces a brief window of `503`s; and there is no per-user
cap on WebSocket connections.

---

## Original brief

Hey — thanks for taking a look at this. Quick bit of context, honestly:

> I've been putting together this little chat / inbox app in my spare time. I rushed it, and I'm
> pretty sure I didn't think a bunch of things through — a few bits don't behave right once you
> actually use it. On top of that I never got around to the features I wanted. I could really use
> a second pair of hands.

So, a few things, if you don't mind:

1. **Get it running** and have a play with it.
2. **Something's off.** A few things don't behave the way they should once there's real traffic.
   Track down what you can and fix it — and leave me a short note per fix on what was actually wrong.
3. **Build some features.** I didn't finish the fun part. The things I had in mind are written up in
   [`tasks/`](tasks/) — pick whichever appeal to you and build **as many as you like** (or your own
   idea). No need to do them all; do good work on the ones you take.
4. **Anything you'd just do differently — do it (or note it).** I rushed this, so the structure, the
   types, bits of plumbing that aren't there... some of it probably makes you wince. If you'd change
   something, improve what bugs you most, or drop a note in [`docs/`](docs/) on what you'd change and
   why. I won't be offended — I'd rather see how you think about it.

### Ground rules

- **Work in your own copy.** Clone this repo, push it to a fresh repo of your own, and send us the
  link when you're done. Public is fine.
- **Leave your working *in* the repo.** Notes, plans, decisions, dead ends — whatever you scribbled
  while figuring it out, commit it. There's a [`docs/`](docs/) and a [`spec/`](spec/) folder for
  exactly that. We care as much about *how* you worked as the final result, so please don't tidy it
  away before you send it.
- **No hard time limit.** A few focused hours is already a solid showing; if you're enjoying it, go
  further.
- Use whatever tools and setup you normally work with.
- Send us **just the link to your repo**, plus a short note on what you changed and why — what was
  broken, what you fixed, what you built.
