# 0015 — Manual verification log

**Kind:** record of what was actually exercised, by hand, in a browser

Docker was unavailable (see [0000](0000-overview.md)), but the `memory` drivers
mean the app itself runs with no external services. So I ran it and drove the
real UI in a real browser rather than only reasoning about it. This is the log
of what I checked and what came back.

```bash
npm run dev:memory      # http://localhost:3000, in-memory store + broker
```

Two browser sessions throughout: `?userId=1` (Alice) and `?userId=2` (Bob).
Fixture is the standard one — Alice+Bob in "Support", Alice+Carol in
"Design sync".

## What I exercised

### Inbox and message flow

| Check | Result |
|---|---|
| App loads, conversations render with counts | ✅ |
| Opening a conversation loads history | ✅ |
| Sending appends live via WebSocket, count increments | ✅ |
| `/healthz` reports `instanceId` | ✅ `{"ok":true,"instanceId":"dev-memory"}` |

### Ordering — and a bug this found

The inbox is ordered most-recently-active first
([0003](0003-n-plus-one-and-indexes.md)), which the server does correctly. But
watching the sidebar while messages arrived, **the order did not update live** —
it only re-sorted on reload. The server's ordering and the client's rendering
had silently diverged.

I would not have found this from the test suite: every assertion about ordering
is against a fresh `GET`, and the client held the list it was first given. Fixed
in `onIncomingMessage` by moving the conversation to the front and refreshing
its `lastMessage`; re-verified below.

### Authorisation ([0010](0010-authorization.md))

| Check | Result |
|---|---|
| Carol posting into Alice+Bob's conversation | ✅ `403 not a participant of this conversation` |
| Carol reading that conversation's history | ✅ `403` |
| Request with no `x-user-id` | ✅ `401 x-user-id header is required` |
| Bob's sidebar shows only his own conversations | ✅ "Design sync" absent |
| Unknown API path | ✅ `404 {"error":"not found"}` |

### Rate limiting ([0006](0006-rate-limiting.md))

Bursting `POST /api/messages` as one user into one conversation:

```
send 1 -> HTTP 201
send 2 -> HTTP 201
send 3 -> HTTP 201   Retry-After: 10
send 4 -> HTTP 429   Retry-After: 10
send 5 -> HTTP 429   Retry-After: 10
```

Five requests admitted, then `429` with `Retry-After`. Immediately afterwards,
**a different user posting into the same conversation got `201`** — the limit is
per user, not per room, which is the requirement most easily got wrong.

### Idempotency ([0009](0009-duplicate-sends.md))

Same `clientId` posted twice:

```
{"id":12,...,"clientId":"abc-123"} <- HTTP 201
{"id":12,...,"clientId":"abc-123"} <- HTTP 200
```

Same id, `200` on the replay, one message in the conversation.

### Search ([0005](0005-search.md))

`?q=refund` as Alice returned the matching message with its
`conversationTitle`. The **same query as Carol returned `[]`** — she is not in
that conversation — while `?q=design` returned her own room's message. Scoping
holds through the real endpoint.

### XSS ([0011](0011-xss-in-sidebar.md))

Created a conversation titled `<img src=x onerror="document.title=...">` and
loaded the page in the browser. Read back from the live DOM:

```json
{ "imgsInSidebar": 0,
  "title": "Relay",
  "sidebarText": "... <img src=x onerror=\"document.title=+ +PWNED+ +\"> (0)" }
```

Zero `<img>` elements, `document.title` untouched, payload displayed as literal
text. This is the same fix the jsdom test covers, confirmed in an actual browser
engine.

### Typing indicator ([0008](0008-typing-indicator.md))

With both tabs open on the same conversation, typing in Alice's composer
produced `#1 is typing…` in Bob's window — visible in the UI, not just in the
frame log. Alice's own window showed nothing (no self-echo). After ~4 s with no
further keystrokes the banner cleared itself:

```json
{ "afterTtl_hidden": true, "text": "" }
```

That is the self-expiry property — no `stop` frame was ever sent.

### Unread dot, and the ordering fix

With Bob viewing "Support", a message was posted to a different conversation he
belongs to. His sidebar:

```json
[ { "text": "<img src=x ...> (1)", "unreadDot": true  },
  { "text": "Support — order #1042 (10)", "unreadDot": false } ]
```

Dot appears on the right conversation only, and it has moved to the top —
confirming the ordering fix above.

### Reconnect ([0012](0012-websocket-reconnect.md))

The one I most expected to be reasoning rather than evidence. I killed the
server with a client connected:

1. Within ~1.5 s the client showed `Reconnecting…` — the silent-death symptom is
   gone.
2. Server restarted.
3. ~10 s later: status cleared, and the sidebar had been **refetched** from the
   restarted server rather than showing its stale list. That is the catch-up
   refetch working, not merely a socket reopening.
4. A message posted afterwards arrived live (count `2 → 3`), so the subscription
   was re-established too.

## What this does *not* cover

The `memory` drivers were in use throughout, so none of this exercises
`SqlMongoStore`, `RedisBroker` or `RedisRateLimiter`. Everything in
[0000](0000-overview.md)'s "not verified" list stands: the MySQL DDL, the Mongo
text index, the Lua script, and the real `--scale api=3` topology behind Envoy.

What it does establish is that the application logic, the HTTP contract, the
WebSocket protocol and the whole frontend behave correctly against a working
backend — which is the half of the risk I could retire without Docker.

Also still unverified by hand: the 1.5 s typing throttle and the 30 s server
heartbeat, both of which need either fake timers or more patience than a manual
session affords.
