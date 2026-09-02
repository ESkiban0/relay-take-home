# 0017 — Second pass: hunting for bugs on the live stack

**Kind:** record — a deliberate bug hunt, everything probed against real
MySQL 8, MongoDB 7, Redis 7 and Envoy in a Codespace

The first pass fixed what the original code got wrong. This one went looking for
what was *still* wrong — including in my own work. It found fourteen issues.
Three of them were mine, and one of those was a silent, total failure of the
headline feature.

Everything below was reproduced against the running stack, not reasoned about.

## Summary

| # | Issue | Severity | Status |
|---|---|---|---|
| 1 | A Redis outage hung every send **forever** | Critical | Fixed |
| 2 | Fail-fast Redis options killed **all** cross-instance real-time | Critical | Fixed (mine) |
| 3 | A failed `SUBSCRIBE` was never retried — instance permanently deaf | High | Fixed |
| 4 | Graceful shutdown hung until SIGKILL whenever a socket was open | High | Fixed (mine) |
| 5 | `npm start` meant node never received SIGTERM at all | High | Fixed (mine) |
| 6 | A Mongo outage cost 30 s per send | High | Fixed |
| 7 | Typing frames had no server-side throttle — room-wide amplification | High | Fixed |
| 8 | `/healthz` reported `ok` while MySQL was down | Medium | Fixed |
| 9 | Unknown participant id returned `500` from a foreign-key violation | Medium | Fixed |
| 10 | No `error` listener on Redis clients | Medium | Fixed |
| 11 | Double-clicking "load older" rendered the same page twice | Medium | Fixed |
| 12 | Switching conversations quickly rendered the wrong one | Medium | Fixed |
| 13 | Envoy returns `503`s while an instance is dying | Medium | Open |
| 14 | No per-user WebSocket connection cap (300 opened in 0.5 s) | Medium | Open |

Plus five smaller observations at the end.

---

## 1. A Redis outage hung every send forever

**Critical.** With Redis stopped, `POST /api/messages` never returned. Not a
slow failure — no response at all:

```
POST with redis down:
HTTP 000            (curl gave up at 45s)
--- was it stored anyway? ---
6 2 1               (unchanged — it never got past the rate limiter)
```

ioredis defaults to `enableOfflineQueue: true`, so every command issued while
Redis is unreachable is buffered and the caller's promise simply never settles.
Each hung request holds a connection, so a Redis blip escalates into the API
running out of connections while the read paths are still perfectly healthy
(`GET /api/conversations` answered in 6 ms throughout).

**Fixed** in `src/infra/redis.ts`: bounded `commandTimeout`, offline queue off
for command connections. Verified — `HTTP 500 in 0.004961s`.

## 2. My fail-fast options killed all cross-instance real-time

**Critical, and self-inflicted.** Applying those same options to the *subscriber*
connection broke the entire multi-instance feature:

```
FAIL  message posted to one instance reaches a socket on another
FAIL  typing signal crosses instances
2/4 checks passed
```

The broker's one `SUBSCRIBE` is issued at boot, before the socket is ready. With
the offline queue disabled it was rejected outright:

```
[broker] subscribe failed Error: Stream isn't writeable and enableOfflineQueue options is false
```

The instance then received nothing, ever. HTTP kept working, messages kept
saving, and the only evidence was one log line at startup.

Two things make this worth dwelling on.

**The unit suite cannot catch it.** All 70 tests pass with this bug present,
because they run against `MemoryBroker` and never construct a `RedisBroker`.
This is precisely the two-implementations risk I wrote up in
[0001](0001-store-abstraction.md) — and it did exactly what I said it might.

**I introduced it while fixing #1**, in the same edit, and shipped it green. Only
re-running the live checks caught it.

**Fixed**: command and subscriber connections now take deliberately different
options, with the reasoning in the file. Verified — 4/4 again.

## 3. A failed subscription was never retried

Underneath #2 sat an older fault of the same shape:

```ts
this.sub.subscribe(CHANNEL).catch((err) => console.error('[broker] subscribe failed', err));
```

Logged once, never retried. ioredis restores subscriptions after a reconnect,
but only ones that previously succeeded — so *any* transient failure at startup
left that instance permanently deaf to real-time, with no ongoing symptom.

**Fixed**: subscribes on every `ready` event. `SUBSCRIBE` is idempotent.

## 4. Shutdown hung until SIGKILL whenever a socket was open

`stop()` closed the HTTP server before the WebSocket hub. `server.close()` does
not call back until every existing connection has ended — and a WebSocket never
ends on its own. So with a single client connected:

```
child> [shutdown] SIGTERM
FAIL  still running 15005ms after SIGTERM — had to SIGKILL it.
```

The handler ran; it just never finished. Every deploy would wait out the full
grace period on every instance.

Mine, and directly contrary to what [0007](0007-multi-instance.md) claimed the
signal handling achieved. **Fixed**: hub first, then the listener. Verified —
`exited after 14ms, code=0`.

## 5. node never received SIGTERM in Docker at all

Even with #4 fixed, the handler could not run in the real deployment:

```
$ docker compose logs api | grep -c shutdown
0
```

`command: npm start` makes PID 1 npm, which does not forward SIGTERM to its
child. So the entire signal-handling block was dead code in the only environment
that matters — masking #4 completely, which is why the two had to be found
together.

**Fixed**: exec form, node directly. Verified — the handler now logs on a real
`docker compose stop`, which completes in 0.2 s.

## 6. A Mongo outage cost 30 seconds per send

```
POST with mongo down: HTTP 500   real 0m30.025s
```

The driver's `serverSelectionTimeoutMS` defaults to 30 s. Every send blocked for
half a minute before failing.

**Fixed**: 3 s, configurable. Verified — `HTTP 500 in 3.025306s`, and the
compensating delete still ran (no orphan rows).

## 7. Typing frames had no server-side throttle

The browser sends at most one frame per 1.5 s. Nothing enforced that:

```
typing flood: sent 2000, other client received 2000 in 4052ms
```

Every frame crossed Redis and fanned out to every subscriber in the room — one
socket amplified across the whole conversation, unbounded. The rate limiter
covers messages only. Combined with #14 this is a cheap denial-of-service.

**Fixed**: per-socket, per-conversation minimum interval in the hub. Verified —
`sent 2000, received 1`.

## 8. `/healthz` lied

```
healthz with MySQL down:        {"ok":true}  HTTP 200
conversations with MySQL down:  HTTP 500
```

It checked nothing. A load balancer or orchestrator would have kept a completely
useless instance in rotation.

**Fixed**: `/healthz` pings the store and returns `503`; `/livez` keeps the
old process-only semantics for liveness probes. Verified live.

## 9. Unknown participant id returned 500

```
participantIds:[1,4242]  ->  500  {"error":"internal error"}
```

A foreign-key violation surfacing as a server fault. It is a client error.

**Fixed**: participants are checked first and reported as
`400 unknown participantIds: 4242`.

## 10. No error listener on the Redis clients

During any outage: `[ioredis] Unhandled error event` on every reconnect attempt
— a tight loop of noise, and on an EventEmitter one refactor away from taking
the process down. **Fixed.**

## 11 & 12. Two client races

Found by reading `web/app.js`, then reproduced in jsdom — both tests fail
against the old code:

**`loadOlder` had no in-flight guard.** Two quick clicks read the same cursor,
issue the same request, and both prepend the same page. Unlike `appendMessage`,
the prepend path had no id de-duplication.

**`openConversation` had no request sequencing.** Open a slow conversation, then
a fast one: the fast response renders, then the slow one arrives and appends
*another conversation's messages* into the open pane, leaving `nextBefore` from
the wrong room too.

**Fixed**: an in-flight guard plus id de-duplication for paging, and a
monotonic load token that makes a superseded response a no-op.

## 13. Envoy returns 503s while an instance is dying — open

```
kill an instance and fire 40 requests immediately:
  38 200
   2 503
```

The cluster has no `health_checks`, no `outlier_detection`, and the route has no
retry policy, so during the DNS-refresh window clients see hard failures.

Not fixed: it is a change to the proxy configuration with its own trade-offs
(retries need idempotency guarantees — which sends now have, via `clientId`).
The shape of the fix is a `retry_policy` with `retry_on: connect-failure` plus
outlier detection.

## 14. No cap on WebSocket connections per user — open

```
opened 300 concurrent sockets as ONE user in 468ms — no per-user cap
```

Each holds memory and receives every broadcast for its subscriptions. With #7
fixed the amplification is bounded, but the connection count is not. A per-user
cap belongs in the hub, and per-IP limits belong at Envoy.

## Smaller observations, not fixed

- **`createdAt` differs between the POST response and storage.** The response
  carries a JS `Date` (`13:17:16.870Z`); MySQL stores its own `CURRENT_TIMESTAMP`
  at second resolution (`13:17:16.000Z`). Harmless today because the client does
  not display timestamps, but two sources of truth for one field will bite.
- **`createRateLimiter` selects its implementation from `config.brokerDriver`.**
  It works, but rate limiting and pub/sub are separate concerns and should not
  share a switch.
- **No rate limiting on search or conversation creation.** Search runs an
  unbounded Mongo text query per request.
- **Raw Mongo `$text` operators reach users.** `-order` silently excludes,
  `"..."` is a phrase query. Reasonable behaviour, but undocumented and
  unintended.
- **`MemoryStore` does not validate participants**, so #9's fix has no in-memory
  equivalent — it has no user table to check against. Another instance of the
  divergence risk from [0001](0001-store-abstraction.md).

## What the exercise says about the test suite

Of the twelve issues fixed, **the existing 70-test suite would have caught
none of them.** They live in exactly the places unit tests with in-memory
doubles cannot reach: driver defaults, signal handling, process supervision,
proxy behaviour, and the wiring between real clients.

The suite is still worth having — it is what let me refactor at all — but the
gap in [0001](0001-store-abstraction.md) is now demonstrated rather than
hypothesised. The concrete next step is the conformance suite named there: run
the same behavioural tests against `SqlMongoStore`, `RedisBroker` and
`RedisRateLimiter` in CI with the real services, which would have caught #2 in
seconds.

The probes written for this pass are committed — `scripts/verify-shutdown.ts`,
`scripts/verify-resilience.ts`, `scripts/verify-multi-instance.ts` — so the
findings are reproducible rather than anecdotal.
