# 0012 — A dropped socket silently ended all live updates

**Kind:** bug — reliability
**Touches:** `web/app.js`, `src/ws/hub.ts`

## Symptom

The app stops updating and gives no sign of it. Messages stop arriving, the
unread dot stops appearing, and everything *looks* fine — the page is rendered,
the composer works, sending still succeeds over HTTP. You only discover the
problem by reloading, at which point a pile of messages appears at once.

Reliably reproducible by closing a laptop lid and reopening it, or by restarting
the proxy.

## Diagnosis

The client connected once and had no `onclose` handler:

```js
function connectWs() {
  if (ws) ws.close();
  ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', ... }));
  ws.onmessage = (ev) => { ... };
}
```

`connectWs()` was called exactly once, from `loadConversations()`. When the
socket died — proxy restart, idle timeout, network change, sleep/wake — nothing
noticed. No reconnect, no error, no indication in the UI.

This is not an edge case. WebSockets through a proxy are dropped routinely:
Envoy has idle timeouts, mobile networks change interface, laptops sleep. A
long-lived socket **will** be closed, so "reconnect" is not error handling, it
is part of the normal lifecycle.

The server had the complementary problem. A socket killed at the network level
— cable pulled, VM destroyed, NAT entry expired — never fires `close`, because
no FIN ever arrives. Those entries stayed in the hub's client set forever, being
written to on every broadcast. It is a slow leak of memory and of pointless
sends, and it is invisible until an instance has been up for weeks.

There was also a smaller bug in the same function: the URL was hardcoded to
`ws://`, so the client could never connect over HTTPS. Not reachable in the
Docker setup, and guaranteed to break on first deploy behind TLS.

## Options — client

**A. Reconnect immediately on close.** Simple, and a disaster during an outage:
every client hammers the server in a tight loop precisely when it is least able
to cope, and they all retry in lockstep because they were all disconnected by
the same event.

**B. Fixed-interval retry** (every 5 s). Better, still synchronised — a
thundering herd on every restart.

**C. Exponential backoff with jitter.** Chosen. Standard for a reason: it backs
off when the server is struggling, and jitter spreads the retries so clients do
not arrive as one wave.

**D. A library** (`reconnecting-websocket` and similar). Reasonable, but this is
about fifteen lines and the project has no bundler, so a dependency here costs
more than it saves.

## Options — server

**A. Rely on TCP keepalive.** OS-level, default timeout measured in hours, not
configurable per-socket from Node. Too coarse.

**B. WebSocket ping/pong heartbeat.** Chosen. The protocol has a control frame
for exactly this. Ping every 30 s; a client that has not ponged since the last
round is terminated.

**C. Application-level heartbeat messages.** Reinvents ping/pong at a higher
layer with more bytes and more code.

## What I did

**Client** (`web/app.js`):

```js
ws.onclose = () => scheduleReconnect();
ws.onerror = () => ws.close();   // funnel both failure paths into one

function scheduleReconnect() {
  const attempt = ++state.reconnectAttempts;
  const delay = Math.min(30000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
  setStatus('Reconnecting…');
  state.reconnectTimer = setTimeout(async () => {
    state.conversations = await api('/api/conversations');   // catch up first
    renderSidebar();
    connectWs();
  }, delay);
}
```

500 ms doubling to a 30 s ceiling, each delay multiplied by a random factor in
`[0.5, 1)`. `reconnectAttempts` resets on a successful open.

Three details that matter more than the backoff itself:

- **The inbox is refetched before reconnecting.** The socket carries no history,
  so anything sent during the gap is lost to the stream. Refetching means the
  reconnect *catches up* rather than merely resuming — otherwise the user
  reconnects successfully and still silently misses the messages from the
  outage, which is the same bug with extra steps.
- **The user is told.** `Reconnecting…` in the status line. The original failure
  was invisible, and an invisible failure is worse than a visible one.
- **Scheme detection.** `location.protocol === 'https:' ? 'wss' : 'ws'`.

**Server** (`src/ws/hub.ts`):

```js
this.#heartbeat = setInterval(() => {
  for (const client of this.#clients) {
    if (!client.alive) { client.socket.terminate(); this.#clients.delete(client); continue; }
    client.alive = false;
    client.socket.ping();
  }
}, HEARTBEAT_MS);
this.#heartbeat.unref?.();
```

`alive` is set on `pong`. The `unref()` matters for the test suite — without it
the interval keeps the process alive and the runner never exits.

Also added `maxPayload: 16 * 1024` on the server, so a client cannot buffer an
unbounded frame.

## Duplicate rendering, which this creates

Reconnecting introduces a new problem: after refetching the inbox and
re-subscribing, a message can arrive that is already on screen. So
`appendMessage` skips ids already rendered:

```js
if (pane.querySelector(`[data-message-id="${m.id}"]`)) return;
```

This is distinct from server-side idempotency ([0009](0009-duplicate-sends.md)),
which stops duplicate *writes*. Both are needed; neither substitutes for the
other.

## Tests

`test/web-render.test.ts`:

- `appends an incoming message once, even if the frame is replayed` — delivers
  the same frame twice and asserts one rendered row. This is the reconnect
  hazard above, tested at the point where it shows.

**The backoff itself is not tested.** It is timer-driven, and asserting it
properly needs fake timers plus a controllable socket — worth doing, not done.
What I did instead is keep the policy to a single pure expression that can be
read at a glance.

`test/realtime.test.ts` exercises the server side incidentally: every socket
test connects, subscribes and closes cleanly, and the harness fails if sockets
are left registered. The heartbeat's *timeout* path (30 s) is not exercised —
that would need either a configurable interval or a fake clock.

## Verification

Verified, including under real failure. Duplicate-frame suppression is covered
by the jsdom test; the rest I exercised by hand ([0015](0015-manual-verification.md)):
with a client connected I killed the server, watched `Reconnecting…` appear
within ~1.5 s, restarted, and confirmed the client cleared the status, refetched
the inbox from the restarted server, and resumed live delivery. The catch-up
refetch is the part I most wanted to see rather than argue for.

Still unverified: the backoff *schedule* (only the first retry was observed, not
the doubling or the ceiling), the jitter, and the 30 s server heartbeat — all
timer behaviour needing fake timers. Also untested against a proxy rather than a
dead server: `docker compose restart envoy` is the case I could not run.
