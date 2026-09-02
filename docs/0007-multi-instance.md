# 0007 — Real-time across several API instances

**Kind:** feature — `tasks/multi-instance.md`
**Touches:** `src/infra/broker.ts`, `src/ws/hub.ts`, `src/routes/messages.ts`, `docker-compose.yml`

> "The proxy will happily spread traffic across instances — try it:
> `docker compose up -d --scale api=3` ...but I've got a feeling the real-time
> side won't survive that."

Correct feeling. It does not survive it at all.

## Why it breaks

The original hub kept its sockets in a module-level `Set`:

```ts
const clients = new Set<Client>();

export function broadcast(conversationId, payload) {
  for (const ws of clients) { /* ... */ }
}
```

That `Set` is per *process*. With three instances behind Envoy:

- Alice's browser opens a WebSocket; Envoy pins it to instance **1**.
- Bob's WebSocket lands on instance **2**.
- Alice `POST`s a message; Envoy round-robins that HTTP request to instance
  **3**.
- Instance 3 writes the message and calls `broadcast`, iterating over *its own*
  socket set — which contains neither Alice nor Bob.

Nobody receives anything. Both users' unread dots and live message panes are
dead, while the message itself is safely in the database. Reloading the page
shows it, which makes the bug look intermittent and cosmetic rather than
structural.

It is worth being precise that this is not an Envoy configuration problem.
`upgrade_configs: [{ upgrade_type: websocket }]` is already there and the
WebSocket connects fine. The problem is entirely that in-process memory is being
used as if it were shared state.

## Options

**A. Sticky sessions at the proxy.** Hash the client to one instance so its
socket and its requests land together. Rejected, and worth explaining because it
is the tempting one: it does not actually fix this. Alice and Bob are different
clients, so they stick to *different* instances — Alice's message still has to
reach Bob's instance. Stickiness only helps when a conversation's participants
all pin to the same place, which nothing guarantees. It also makes deploys and
instance loss worse, since every restart drops a fixed slice of users.

**B. Instances gossip directly** — each instance connects to every other and
forwards events. No new dependency. Rejected: `O(n²)` connections, plus service
discovery, plus membership and failure handling. That is a distributed systems
project, and it is what a message broker already is.

**C. Redis pub/sub.** Chosen. Redis is already in the compose file, already
needed for rate limiting ([0006](0006-rate-limiting.md)), and pub/sub is
precisely this problem. Publish an event; every instance receives it and
delivers to whichever of its own sockets care.

Its limitation, stated up front: Redis pub/sub is **fire-and-forget**. An
instance that is disconnected at the moment of publication misses the event
permanently — there is no replay. That is acceptable here because the WebSocket
stream is not the source of truth: the message is in MySQL, and a client that
reconnects re-fetches ([0012](0012-websocket-reconnect.md)). It would not be
acceptable if the socket were the only delivery path.

**D. Redis Streams, or a real broker (NATS/Kafka).** Consumer groups, replay,
at-least-once delivery. The right answer if missed frames mattered. Rejected as
disproportionate for a presence/notification channel whose data is already
durable elsewhere.

## What I did

A `Broker` interface with `RedisBroker` (two connections — a Redis client in
subscriber mode cannot issue normal commands) and `MemoryBroker`. Producers no
longer touch sockets:

```ts
// routes/messages.ts
await broker.publish({ conversationId, payload: { type: 'message', ...message } });
```

and the hub subscribes:

```ts
// ws/hub.ts
this.broker.subscribe((event) => this.#deliver(event.conversationId, event.payload));
```

### The publisher does not deliver locally

This is the detail worth calling out. The obvious implementation — deliver to
local sockets *and* publish for the others — is wrong in both directions at
once: on the originating instance every subscriber gets the message twice
(locally, then again from its own subscription), and if you suppress the
self-delivery to fix that, you have two divergent code paths where one is
exercised only in production.

So `publish` only publishes. Every instance, including the one that produced the
event, delivers when its subscription fires. One path, exercised identically
whether there is one instance or ten. `test/realtime.test.ts` →
`delivers exactly once to each subscriber, including on the origin instance`
pins this.

### Supporting changes

- `docker-compose.yml`: the `api` service now waits on a Redis healthcheck.
  Without it, instances race Redis on boot and crash-loop.
- `INSTANCE_ID` (a UUID by default) is reported by `/healthz` and carried on
  every broker frame — the practical way to confirm you are actually talking to
  three different instances.
- `SIGTERM`/`SIGINT` handling in `src/index.ts`, so `docker compose down` does
  not wait out the grace period on each instance.

## Tests

`test/realtime.test.ts` → `multiple API instances`. Two complete harnesses —
each with its own HTTP server, its own `Hub`, its own WebSocket listener —
sharing one `Store` and one `Broker`. That is structurally what `--scale api=3`
produces: separate processes, shared backing services.

- `delivers a message posted to one instance to a socket on another` — the exact
  failure above. Bob's socket is on instance B; the `POST` goes to instance A.
  Fails against the original in-process `Set`.
- `delivers a typing signal across instances` — the same for
  [0008](0008-typing-indicator.md), which is broker-carried for the same reason.
- `delivers exactly once to each subscriber, including on the origin instance` —
  the double-delivery trap.

## Verification

Partly verified — and this is the change where the gap matters most, so read the
distinction carefully.

**Verified:** the architecture. Two independent app instances with independent
WebSocket hubs, sharing a broker, deliver correctly and exactly once. That is
the property the task is about, and it is genuinely exercised.

**Also verified against the real thing** — see
[0016](0016-live-stack-verification.md). `docker compose up -d --scale api=3`,
three API containers behind Envoy, real Redis pub/sub, driven by
`scripts/verify-multi-instance.ts`:

```
PASS  proxy spreads HTTP across instances
      3 distinct instanceId(s) over 12 requests
PASS  message posted to one instance reaches a socket on another
PASS  typing signal crosses instances
PASS  rate limit budget is shared across instances
      5 of 10 accepted; a per-process counter would allow 15
```

So `RedisBroker` and the wiring are no longer taken on trust.

Worth recording: the rate-limit check **initially passed for the wrong reason**
— it probed as a non-participant, so every request was rejected `403` before the
limiter was consulted. A green check that tests nothing is worse than a missing
one; it is fixed and the corrected run is the one quoted above.

Still unverified: `docker compose restart redis` — how a live subscription
recovers when the broker restarts under load. That is the part I would least
trust without seeing it, and I have not seen it.
