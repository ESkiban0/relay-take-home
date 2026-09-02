# 0006 — Rate limiting on sends

**Kind:** feature — `tasks/rate-limiting.md`
**Touches:** `src/infra/rate-limit.ts`, `src/routes/messages.ts`, `web/app.js`

The brief, restated:

- ~5 messages per 10 s, per user, per conversation;
- over the limit → `429` with a `Retry-After`;
- per user — one noisy person must not throttle the room;
- must hold with more than one API instance.

That last point is the whole design constraint. An in-process counter is a
handful of lines and satisfies the first three; it fails the fourth completely,
and it fails *silently* — with three instances behind a round-robin proxy, a
"5 per 10 s" limit becomes 15 per 10 s and nothing reports that it is wrong.

## Options — where the state lives

**A. In-process `Map`.** Fails the multi-instance requirement. Kept as
`MemoryRateLimiter`, used by tests and `dev:memory`, never in the stack.

**B. Redis.** Chosen. Redis is already in `docker-compose.yml` and in
`.env.example` — it was provisioned and unused, which reads like the intended
direction. It is also needed anyway for real-time fan-out
([0007](0007-multi-instance.md)), so this adds no new infrastructure.

**C. MySQL.** Possible, and one less service — but a write-heavy row per send,
contending with the message insert on the same database, to store data that is
worthless in ten seconds. Wrong tool.

**D. At the proxy (Envoy).** Envoy has a rate-limit filter, and doing it at the
edge keeps the app simpler. Rejected: the limit is *per user per conversation*,
and Envoy would have to parse the JSON body to learn the conversation and trust
a client-supplied identity to learn the user. Envoy is the right place for
coarse per-IP protection — which is a genuinely useful complement, since this
limit does nothing against an attacker who rotates the `x-user-id` header — but
not for a domain limit like this one.

## Options — the algorithm

**Fixed window.** `INCR` a key named for `floor(now / window)`, expire it. Two
commands, trivially correct-looking. Rejected because of the boundary: five
sends at 9.9 s and five more at 10.1 s is ten sends in 200 ms, all allowed. The
burst it lets through is exactly the "runaway script flooding a conversation"
the task describes. It also cannot produce an accurate `Retry-After` — only time
until the window resets, which over-reports.

**Token bucket.** Good properties, allows a deliberate burst, cheap to store
(two numbers). Genuinely a close call. Rejected because the brief is phrased as
a hard count per interval, and a bucket's refill rate expresses that less
directly; and `Retry-After` requires deriving time-to-next-token rather than
reading it off.

**Sliding window log.** Chosen. One sorted-set entry per allowed send, scored by
timestamp; drop entries older than the window, count what remains. The guarantee
holds at *every* window position, not just at aligned boundaries, and
`Retry-After` is exact — it is when the oldest entry falls out. The cost is
`O(limit)` storage per key instead of `O(1)`; at 5 entries per user per
conversation with a 10 s TTL that is nothing.

## Atomicity

The three steps — prune, count, insert — must be one operation. As separate
round trips, concurrent requests all read the same pre-insert count and all
decide they are under the limit. That is not a rare interleaving; it is the
common case when someone holds down a send button, which is the scenario being
defended against.

So it is a Lua script, which Redis evaluates atomically:

```lua
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)
if used < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - used - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, math.max(0, window - (now - tonumber(oldest[2])))}
```

`PEXPIRE` on every call means an abandoned key evicts itself; there is no
cleanup job and no unbounded key growth.

Timestamps come from the app, not Redis, so clock skew between instances is a
real (small) source of imprecision. `TIME` inside the script would remove it,
but historically made scripts non-deterministic for replication; for a limit
whose numbers are explicitly "not sacred", app time is the right trade.

## Placement in the request

Order in `POST /api/messages` is deliberate:

```
validate → membership check → rate limit → write → broadcast
```

- **After validation**, so malformed requests do not consume a caller's budget.
- **After the membership check**, so a stranger cannot spend a participant's
  allowance for a conversation they are not even in. Getting this backwards
  turns the rate limiter into a denial-of-service tool. There is a test for it.
- **Before the write**, so a rejected send costs one Redis round trip, not a
  MySQL insert plus a Mongo insert.

Key: `ratelimit:msg:{userId}:{conversationId}` — per user *and* per conversation,
as specified.

## The client half

A `429` that loses the user's message is a worse bug than no rate limit. So
`web/app.js` puts the text back in the composer, and shows *"Sending too fast —
try again in Ns"* using the `Retry-After` value. The send button is also
disabled while a request is in flight, which removes the most common way of
hitting the limit at all.

## Tests

`test/rate-limit.test.ts`, 11 cases across two levels.

The algorithm (`MemoryRateLimiter`, which runs the same logic as the Lua):

- `allows exactly limit calls per window` — and that `remaining` counts down.
- `reports a retry delay bounded by the window`.
- `lets calls through again once the window slides past them`.
- `does not let a burst straddle a window boundary` — 3 calls, wait past where a
  *fixed* window would reset, assert the 4th is still denied. **This test is the
  reason for the algorithm choice**: a fixed-window implementation passes every
  other test here and fails this one.
- `keys are independent`.

The HTTP surface:

- `rejects with 429 and a Retry-After once over the limit` — status, and that
  the header is a sane integer.
- `does not store the rejected message` — rejection is not just a status code.
- `throttles the noisy user only` — Alice exhausts her budget, Bob sends into
  the same conversation and succeeds. The core requirement.
- `is scoped per conversation` — Alice blocked in one room, fine in another.
- `checks membership before spending budget` — a non-participant gets `403` five
  times and the participant's allowance is untouched.

## Verification

Partly verified. The algorithm, the HTTP behaviour, the scoping and the
`Retry-After` header are all covered by the suite, and I also confirmed them
against the running app by hand — five sends admitted, then `429` with
`Retry-After: 10`, and a second user immediately getting `201` in the same
conversation ([0015](0015-manual-verification.md)). But all of that is
`MemoryRateLimiter`.

**The Lua script now runs against Redis 7** — see
[0016](0016-live-stack-verification.md). I had flagged Lua's
`ZRANGE ... WITHSCORES` return shape as the thing most likely to be right in
reasoning and wrong in practice; it is correct. Five sends admitted, then `429`
with `Retry-After: 10`, and the keys present in Redis (`ratelimit:msg:1:1`,
`ratelimit:msg:2:1`) confirm the per-user-per-conversation scoping.

The case the in-memory limiter could never express is verified too: across
**three API instances behind Envoy**, exactly 5 of 10 sends were accepted, where
a per-process counter would have allowed 15.

Still unverified: behaviour under genuinely concurrent load. Every probe was
sequential, so the atomicity argument for using a script at all remains reasoned
rather than measured.
