# 0010 — Any client could read any conversation

**Kind:** bug — security
**Touches:** `src/ws/hub.ts`, `src/http/current-user.ts`, all routes

## Symptom

None visible. That is what makes it the most serious bug in the repo: nothing
misbehaves, and every private conversation in the system is readable by anyone
who can open a socket.

## Diagnosis

Three independent holes, all variations of "the client asserts something and the
server believes it".

**1. WebSocket subscriptions were unchecked.**

```ts
if (m.type === 'subscribe' && Array.isArray(m.conversationIds)) {
  ws.subs = new Set(m.conversationIds.map(Number));
}
```

The client says which conversations it wants; the server writes that down and
starts forwarding. `{"type":"subscribe","conversationIds":[1,2,3,...,10000]}`
subscribes to every conversation in the system and streams every message sent
anywhere, live. No account needed — the socket carried no identity at all.

**2. `GET /api/messages` had no membership check.**

```js
const conversationId = Number(req.query.conversationId);
const [rows] = await pool.query('SELECT ... WHERE conversation_id = ?', [conversationId]);
```

`/api/messages?conversationId=1` returns conversation 1's full history to
anybody. The conversation list *was* correctly scoped by a join on
`conversation_participants`, which is what makes this easy to miss in review —
one endpoint establishes the expectation that scoping is handled, and the
neighbouring one does not do it.

**3. `senderId` came from the request body.**

```js
const { conversationId, senderId, body, clientId } = req.body || {};
```

Anyone could post as anyone. `{"senderId": 2, ...}` and the message is Bob's,
permanently, in the database.

## Options

**A. Add real authentication.** Sessions or signed tokens, a login screen, a
user table with credentials. Rejected as out of scope: the app has no auth
concept whatsoever, and building one is a feature, not a bug fix. I did not want
to hand back a take-home that had quietly grown a login system instead of the
things that were asked for.

**B. Fix only the WebSocket hole**, since it is the most dramatic. Rejected —
the three are one bug wearing three hats, and fixing one leaves the same data
readable through the others.

**C. Introduce a caller-identity seam and enforce membership everywhere behind
it.** Chosen.

## What I did

**A single place that answers "who is calling"** — `currentUserId(req)` in
`src/http/current-user.ts`, reading an `x-user-id` header. Its doc comment says
plainly what it is:

> THIS IS NOT AUTHENTICATION. The caller still asserts its own identity, exactly
> as the original code did — anyone can claim to be user 7.

This is the honest part of the change and I want to be direct about it: **the
system is still not secure.** What changed is its shape. Before, authorisation
was absent and there was nowhere to put it; now every handler asks one function
who the caller is, and every conversation-scoped operation checks membership
against that answer. Replacing `currentUserId` with a verified session makes the
whole thing correct in one file, because everything downstream is already
written as though the identity were trustworthy.

An unenforced-but-consistent policy is worth much more than no policy: the
enforcement points exist, they are tested, and they cannot be forgotten later.
Retrofitting them after auth lands is how endpoints get missed.

**Membership as an explicit precondition.** `Store.isParticipant()` gates
posting and reading history; `conversationIdsForUser()` scopes the inbox, search
([0005](0005-search.md)) and subscriptions. Non-membership is `403`, not `404` —
this app already leaks conversation existence through sequential integer ids, so
`404` would be security theatre rather than real ambiguity.

**Subscriptions are intersected, never trusted:**

```ts
const requested = new Set(frame.conversationIds.map(Number).filter(Number.isInteger));
const allowed = await this.store.conversationIdsForUser(client.userId);
client.subs = new Set(allowed.filter((id) => requested.has(id)));
send(client.socket, { type: 'subscribed', conversationIds: [...client.subs] });
```

Starting from `allowed` and filtering by `requested` — rather than starting from
the request — means an id the user has no claim to cannot survive the operation
regardless of what the frame contained. The server also echoes back what it
actually granted, so a client can tell the difference between "subscribed" and
"silently ignored", and so the test can assert on it.

The socket now carries an identity too (`?userId=` on the handshake); a
connection without one is closed with `4001` rather than being allowed to sit
there anonymously.

**`senderId` is ignored.** It comes from `currentUserId`, and a `senderId` in
the body is discarded — there is a test that posts one and asserts it had no
effect.

## What I would do next

`x-user-id` is a placeholder and should not survive contact with real users. The
smallest honest replacement: a signed session cookie or a JWT, verified in
`currentUserId`, with the rest of the code unchanged. Also worth adding at that
point: rate limiting keyed on something the client cannot rotate freely
([0006](0006-rate-limiting.md) notes that per-IP limiting at Envoy is the
complement), and an audit of `403` vs `404` semantics once ids are no longer
guessable.

## Tests

Across three files:

`test/realtime.test.ts` → `subscription authorisation`:
- `drops conversations the user does not belong to` — Carol asks for both rooms,
  is granted only hers.
- `does not deliver messages from an unauthorised conversation` — a message is
  sent to the room she asked for but does not belong to, then one to a room she
  does; she receives exactly one frame. The second message is the
  synchronisation point: if the private one were leaking, it would already have
  arrived.
- `rejects a connection without a userId` — asserts close code `4001`.

`test/messages.test.ts`:
- `refuses to post into a conversation the caller is not in` → `403`.
- `takes the sender from the caller identity, not from the payload` — posts
  `senderId: 999` as user 2, asserts the stored sender is 2.

`test/messages.test.ts` → `GET`:
- `refuses conversations the caller is not in` → `403`.

`test/search.test.ts`:
- `scopes results to the caller: Carol cannot see the support room`.

`test/conversations.test.ts`:
- `returns only the conversations the caller participates in`.
- `requires a caller identity` → `401`; `rejects a malformed identity rather
  than coercing it` → `400`, not a silent `Number('abc') → NaN`.

The fixture is built for this: Alice(1)+Bob(2) in one room, Alice(1)+Carol(3) in
another, so Carol is a real outsider to a real conversation in every test file.

## Verification

Verified. Every check above runs in the suite against the real Express app and
real WebSockets, and the HTTP half was re-confirmed by hand against the running
app — `403` on both posting and reading a conversation the caller is not in,
`401` with no identity, and a sidebar showing only the caller's own
conversations ([0015](0015-manual-verification.md)).

Nothing here depends on the store implementation, so this is one of the few
changes with no live-infrastructure caveat. The caveat that does apply is the
one stated above: this is authorisation without authentication.
