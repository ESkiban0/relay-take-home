# 0016 — Verification against the live stack

**Kind:** record — everything [0000](0000-overview.md) previously listed as unrun

I could not run Docker locally (Hyper-V guest, no nested virtualisation), so the
first pass of this work shipped with `SqlMongoStore`, `RedisBroker`,
`RedisRateLimiter`, the MySQL DDL, the Mongo text index and the Envoy scale-out
all **unexecuted**. This document closes that gap: a GitHub Codespace with
Docker-in-Docker, running the real `docker compose` stack.

```bash
docker compose up -d --build
docker compose up -d --scale api=3
```

Everything below ran against MySQL 8, MongoDB 7, Redis 7 and Envoy.

## Getting there — two devcontainer failures worth recording

Neither was in the app, but both cost time and both were misleading, so they are
in the repo history rather than tidied away.

1. **`moby` is not published for Debian trixie.** The `javascript-node:22` image
   moved to trixie, so the `docker-in-docker` feature failed to install, the
   container build failed, and Codespaces silently substituted an **Alpine
   recovery container**. The symptom was `docker: command not found` — which
   reads as "the feature did not apply", not "the build failed and you are in a
   different container entirely". Fixed with `"moby": false` (upstream Docker CE).
2. **No SSH server in the image.** `gh codespace ssh` could not attach. The
   confusing part: the *first* codespace accepted SSH — because the Alpine
   recovery image happens to ship `sshd`. Fixed by adding the `sshd` feature.

## Store: MySQL + Mongo ([0003](0003-n-plus-one-and-indexes.md), [0013](0013-unbounded-history.md))

The rewritten inbox query runs, and ordering by activity is correct against real
SQL — "Design sync" (message id 3) sorts above "Support" (id 2):

```json
[{"id":2,"title":"Design sync","messageCount":1,
  "lastMessage":{"id":3,"body":"Notes from the design sync are in the doc."}},
 {"id":1,"title":"Support — order #1042","messageCount":2,
  "lastMessage":{"id":2,"body":"Checking now — give me a minute."}}]
```

`lastMessage.body` is populated, which the original never did — it selected no
body for the preview at all.

### The indexes, and a claim I had got wrong

`SHOW INDEX` confirms all of the new DDL applied: `uniq_messages_client`,
`idx_messages_conversation_recent`, `idx_participants_user`, the foreign keys.

`idx_participants_user` behaves as [0003](0003-n-plus-one-and-indexes.md)
predicted — the inbox join uses it as a **covering** index (`type: ref`,
`Extra: Using index`).

But my claim about the history query was wrong as stated. I wrote that it would
be "a range scan on `idx_messages_conversation_recent` with no filesort". What
actually happens depends on the conversation, and I only found this by running
it. With ~950 000 messages:

| Conversation | Rows | Plan chosen |
|---|---|---|
| Dense, recent (250k rows) | 250 021 | `PRIMARY`, backward index scan |
| Dense, recent (50k rows) | 50 000 | `PRIMARY`, backward index scan |
| Tiny and old (20 rows, buried) | 20 | `uniq_messages_client`, **Using filesort** |
| **Large and archived (50k rows, buried under 900k newer)** | 50 000 | **`idx_messages_conversation_recent`, `Extra: NULL`** |

Two things fall out of this.

**My index is not used for the common case, and that is correct.** For a
conversation receiving recent traffic, walking the primary key backwards finds
50 matching rows almost immediately, and MySQL is right to prefer it.

**`uniq_messages_client` doubles as an access path**, because it also leads with
`conversation_id`. That is why the sparse case picks it — and pays a filesort,
which is harmless at 20 rows but is the shape of a real problem at scale.

**The index earns its place in exactly one case — and that case is worth it.**
For a large conversation with no recent activity, the primary-key scan has to
walk the whole tail of the table. Measured, same query, same data:

```
1  0.00101125  SELECT id FROM messages WHERE conversation_id=97 ORDER BY id DESC LIMIT 50
2  0.07453150  SELECT id FROM messages IGNORE INDEX (idx_messages_conversation_recent) ...
```

**1.0 ms with the index, 74.5 ms without — 74×**, and `Extra: NULL` confirms the
index supplies the ordering so there is no sort at all. Any product with
archived-but-large conversations hits this constantly.

So the index stays, but the honest description is *"the optimiser selects it for
large low-activity conversations, where it is ~74× faster; elsewhere the primary
key is cheaper and is correctly preferred"* — not the blanket claim I made.
[0003](0003-n-plus-one-and-indexes.md) and [0013](0013-unbounded-history.md) are
corrected accordingly.

## Idempotency: the real unique key ([0009](0009-duplicate-sends.md))

The part that could not be tested in memory — the `ER_DUP_ENTRY` catch against
an actual `UNIQUE KEY`:

```
{"id":5,...,"clientId":"dup-1"} <- HTTP 201
{"id":5,...,"clientId":"dup-1"} <- HTTP 200
```

Same id, `200` on the replay. The constraint fires and the handler recovers the
original row rather than erroring. Also confirmed: `NULL` client ids do not
collide — the seed rows all carry `client_id NULL` and coexist under the unique
key, and ~950 000 rows were later inserted with `NULL` without a single
violation.

## Search: the Mongo text index ([0005](0005-search.md))

Stemming works as claimed — the specific thing I flagged as needing a live
check. Query `refund`, stored text "Your **refunds** have been issued":

```json
[{"messageId":4,"conversationTitle":"Support — order #1042",
  "body":"Your refunds have been issued"}]
```

And the same query as a non-participant returns `[]`. Scoping holds through the
real Mongo query, not just the in-memory approximation.

## Rate limiting: the Lua script ([0006](0006-rate-limiting.md))

The Lua had never executed, and I called out `ZRANGE ... WITHSCORES` as the
thing most likely to be right in reasoning and wrong in practice. It is correct:

```
send 1..5 -> 201
send 6    -> 429   retry-after: 10
send 7    -> 429   retry-after: 10
```

Keys in Redis confirm the scoping is per user *and* per conversation:

```
ratelimit:msg:1:1
ratelimit:msg:2:1
```

and user 1 sending into the same conversation while user 2 was exhausted
returned `201`.

## Multi-instance: `--scale api=3` behind Envoy ([0007](0007-multi-instance.md))

This is the one the tests could only approximate — they ran two app instances
over a shared *in-process* broker. Here it is three real containers, real Envoy,
real Redis pub/sub. `scripts/verify-multi-instance.ts` drives it:

```
PASS  proxy spreads HTTP across instances
      3 distinct instanceId(s) over 12 requests
PASS  message posted to one instance reaches a socket on another
      POST returned 201; socket received id=19
PASS  typing signal crosses instances
      received typing from user 1, expires in 3999ms
PASS  rate limit budget is shared across instances
      5 of 10 accepted; limit is 5, a per-process counter
      across 3 instances would allow up to 15

4/4 checks passed
```

The last line is the one that matters most, and it nearly slipped through: **the
first version of that check probed as a non-participant**, so all nine requests
were rejected `403` before the limiter was ever consulted — and it reported
`PASS`. A check that passes for the wrong reason is worse than no check. Fixed
to probe as a participant; the corrected run gives exactly 5 of 10 accepted
across three instances, where a per-process counter would have allowed 15.

Confirmed by hand as well, straight through the proxy:

```
201 201 201 201 201 429 429 429 429
accepted=5 denied=4
```

## Test suite on Linux

`npm test` → **64/64**, `npm run typecheck` clean, inside the container. Rules
out Windows-only behaviour in the suite I developed against.

## What is still not verified

- **Envoy WebSocket idle-timeout / proxy-restart reconnection.** I verified
  reconnect against a killed *server* ([0015](0015-manual-verification.md)), not
  a restarted proxy.
- **Redis failover.** What the broker does when Redis restarts under load —
  `ioredis` reconnects, but I have not watched a subscription recover.
- **The compensating delete in [0014](0014-cross-store-consistency.md).** It
  needs an induced Mongo failure mid-write; the test sketch in that document
  still stands as unrun. It remains the change with the weakest evidence.
- **Concurrency at the rate limiter.** Sequential requests only; the atomicity
  argument for the Lua script is untested under genuinely parallel load.

## Note on the data

The measurements above left ~950 000 synthetic rows in that Codespace's MySQL.
It is a disposable environment and nothing in the repo depends on it; a fresh
`docker compose up` seeds only the three demo messages.
