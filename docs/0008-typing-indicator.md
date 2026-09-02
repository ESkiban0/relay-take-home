# 0008 — Typing indicator

**Kind:** feature — `tasks/typing-indicator.md`
**Touches:** `src/ws/hub.ts`, `src/config.ts`, `web/app.js`, `web/index.html`

> "You can't tell when the other person is in the middle of replying, so it
> feels dead even when someone's about to answer."

## Design

Typing is *presence*: high-frequency, worthless a few seconds later, and fine to
lose. That shapes every decision below — it is the one piece of data in this app
that should never touch a database.

### Transport: WebSocket, not HTTP

An HTTP `POST /api/typing` would work, but it means a request per keystroke
burst, each carrying headers and going through the whole middleware stack, for
something with a two-second shelf life. The socket is already open in both
directions. `{ type: 'typing', conversationId }` is a frame on it.

### Expiry, not start/stop

The obvious protocol is `typing_start` / `typing_stop`. I did not use it,
because it is the one that breaks: the `stop` gets lost. Tab closed, network
dropped, browser killed mid-sentence — and the indicator says "Bob is typing…"
forever, for everyone, until they reload. Every implementation that does this
ends up bolting a timeout on anyway.

So there is only one frame type, and it carries an expiry:

```ts
payload: { type: 'typing', conversationId, userId, expiresAt: Date.now() + config.typingTtlMs }
```

The client shows the indicator while `expiresAt` is in the future and drops it
otherwise, re-evaluating on a 1 s tick. **The absence of a signal is the stop
signal**, so there is no message whose loss leaves stuck state. A user who keeps
typing keeps refreshing their own expiry.

`TYPING_TTL_MS` defaults to 4000 against a client that re-sends at most every
1500 ms — comfortably more than one send interval, so a single dropped frame
does not flicker the indicator off.

### Throttling on the client

`notifyTyping()` sends at most one frame per 1.5 s regardless of typing speed. A
frame per keystroke would be ~5/second per user, which is real traffic to the
broker and to every subscriber for no added information.

### Fan-out via the broker

Typing goes through the same `Broker` as messages ([0007](0007-multi-instance.md)),
for the same reason: the typist's socket and the recipient's socket are
routinely on different instances. A typing indicator that works locally and
silently dies at `--scale api=3` would be the same bug in a new place.

### Not echoed to the typist

The hub suppresses delivery back to the originating user:

```ts
if (isTyping && client.userId === authorUserId) continue;
```

Telling you that you are typing is noise, and it would show on your other open
tabs as though someone else were.

### Authorisation

A `typing` frame is only accepted for a conversation the socket is already
subscribed to — and subscriptions are themselves filtered against real
membership ([0010](0010-authorization.md)). So typing cannot be used to probe
for the existence of conversations, or to inject presence into a room you are
not in. Unlike a message, it is not separately membership-checked at send time
because the subscription set is already the authorised set.

## What I did not build

- **Per-name display.** The UI shows `#2 is typing…` because the app has no user
  directory endpoint — `users` exists in MySQL but nothing exposes it. Adding
  `GET /api/users` for this felt like scope creep into a different feature;
  showing the id is honest about what the client knows.
- **Persistence or history.** Deliberately none. Presence in a database is
  almost always a mistake.
- **Read receipts / online status.** Adjacent, not asked for.

## Tests

`test/realtime.test.ts` → `typing`:

- `reaches other participants but not the typist` — Bob receives Alice's signal
  with the right `userId`, `conversationId` and a future `expiresAt`; Alice's
  own socket receives nothing.
- `is ignored for a conversation the sender is not subscribed to` — Carol sends
  a typing frame for the support room; Bob, who is subscribed to it, receives
  nothing.
- `carries an expiry so a vanished typist clears on its own` — runs with
  `typingTtlMs: 50`, and asserts the signal has lapsed with **no further frame
  sent**. This is the property that distinguishes this design from
  `start`/`stop`: expiry happens without cooperation from the typist.

And across instances, in `multiple API instances`:

- `delivers a typing signal across instances` — Alice on instance A, Bob on
  instance B.

Also relevant: `ignores malformed frames instead of dropping the connection`,
since the hub now handles more than one frame type.

Client-side, in `test/web-render.test.ts` (jsdom, added while writing up
[0011](0011-xss-in-sidebar.md)):

- `shows a banner while the signal is live`.
- `hides the banner once the signal has expired, with no stop frame` — delivers
  a signal whose `expiresAt` is already past and asserts the banner stays
  hidden. This is the design property under test, from the client side.

Not covered: the 1.5 s send throttle and the 1 s expiry tick, both of which are
timer behaviour that would need fake timers to assert meaningfully.

## Verification

Verified. Server-side — frames, expiry, suppression of the self-echo,
authorisation and the cross-instance path — runs over real WebSockets in the
suite. Client-side rendering runs in jsdom.

I also drove it by hand in two browser sessions against the running app: typing
as Alice showed `#1 is typing…` in Bob's window, nothing in her own, and the
banner cleared itself after the TTL with no stop frame
([0015](0015-manual-verification.md)).

Not verified: the 1.5 s throttle timing, and the cross-instance path against a
real Redis rather than a shared in-process broker.
