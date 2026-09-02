# 0005 — Search

**Kind:** feature — `tasks/search.md`
**Touches:** `src/routes/search.ts`, `src/store/*`, `src/db/mongo.ts`

> "Once a conversation has a lot of messages I can never find anything again."

The route existed as a stub returning `[]`, and the frontend was already wired
to it, so the work is entirely server-side.

## What "search" means here

The task leaves the scope open, so the first decision is where to stop. What I
built:

- **word-based**, not substring — searching `refund` finds "Your REFUND has been
  issued", but `fun` does not;
- **case- and accent-insensitive**, with basic English stemming (`refund`
  matches `refunds`);
- **all terms must match** — `design pass` finds messages containing both;
- **scoped to the caller's conversations**, always;
- newest-first within relevance, capped at `SEARCH_LIMIT` (50).

What I did not build: fuzzy matching, phrase queries, per-conversation
filtering, highlighting, or pagination of results. Each is a reasonable next
step; none is needed to answer "I can never find anything".

## Where the data is

The constraint that drives everything: **message bodies are in MongoDB, not
MySQL.** Metadata is in MySQL. Search reads bodies and needs conversation
titles, so it necessarily touches both.

## Options

**A. `LIKE '%term%'` in MySQL.** Immediately wrong — the bodies are not in
MySQL. It would mean duplicating every body into a second store.

**B. Mongo regex scan** — `{ body: { $regex: q, $options: 'i' } }`. Five lines
and gives substring matching, which is nicer for short queries. Rejected: an
unanchored case-insensitive regex cannot use an index, so it is a collection
scan on every keystroke. That is precisely the "lots of messages" case the task
is about — it would work perfectly on the seed data and fall over exactly when
it matters.

**C. Mongo text index.** Chosen. `createIndex({ body: 'text' })` and
`$text: { $search: q }`. Indexed, so it scales; gives stemming, stop words and
`textScore` ranking for free; ships with the database already in the stack.

Its costs, stated plainly: one text index per collection, no substring or prefix
matching, and English-only stemming as configured. The substring limitation is
the one a user would actually notice.

**D. Add Elasticsearch / OpenSearch.** The real answer for a product where
search matters — proper analysers, fuzziness, highlighting, relevance tuning.
Rejected as wildly disproportionate: a whole new service, its own operational
burden, and an index-synchronisation problem to keep correct, to improve on
something that is currently a stub. If search becomes central this is the
migration, and option C's `Store` method is the seam it would go behind.

**E. MySQL `FULLTEXT`, having moved bodies into MySQL.** Worth naming because
the two-store split is arguably the questionable thing here — bodies in Mongo
buy little and cost a join on every read plus the consistency problem in
[0014](0014-cross-store-consistency.md). Consolidating into MySQL would make
search a `MATCH ... AGAINST` and delete a whole class of bug. Rejected as out of
scope: it is a data migration and a change to the app's given architecture, not
a feature. Flagging it as the thing I would question first.

## What I did

Index creation in `ensureMongoIndexes` (`src/db/mongo.ts`), called on every API
boot and by the seed job. `createIndex` is idempotent, so several instances
starting at once is fine:

```ts
await bodies.createIndex({ body: 'text' }, { name: 'body_text' });
await bodies.createIndex({ conversationId: 1, _id: -1 }, { name: 'conversation_recent' });
```

The query (`SqlMongoStore.searchMessages`) is two steps: resolve the caller's
conversation ids from MySQL, then a single Mongo query filtered by those ids and
`$text`, sorted by `textScore` then `_id` descending. Titles are hydrated with
one more MySQL query over the distinct conversation ids in the results.

### Scoping is in the query, not after it

```ts
const visible = await this.conversationIdsForUser(userId);
if (!visible.length) return [];
const docs = await this.bodies.find({ conversationId: { $in: visible }, $text: { $search: query } })
```

The filter is *part of* the database query, not a `.filter()` applied to the
results. Search is the easiest endpoint on which to accidentally build
read-anything: the original stub took no user at all, and the obvious
implementation — search everything, then drop what the user cannot see — is one
forgotten line away from a full-corpus leak, and leaks the result count even
when it works. Making it a precondition of the query means there is no moment at
which unauthorised rows exist in the process.

## Tests

`test/search.test.ts`, 8 cases:

| Test | What it pins |
|---|---|
| `requires a caller identity` | no anonymous search |
| `returns an empty list for a blank query` | `?q=` short-circuits |
| `finds messages by word, case-insensitively` | core matching |
| `returns the fields the sidebar renders` | the response contract `renderResults` consumes |
| `scopes results to the caller` | Carol searching `order` gets nothing from Alice and Bob's room |
| `requires every term to match` | `design pass` hits, `design bicycle` does not |
| `returns nothing for a term that appears nowhere` | no false positives |
| `caps the number of results` | `SEARCH_LIMIT` is enforced |

**Ranking is deliberately not asserted.** Mongo orders by `textScore`; the
in-memory store orders by recency and does not compute a score. A test pinning
result *order* would pass against one implementation and be a false statement
about the other. So the suite asserts what both genuinely promise — matching,
scoping, field shape, limit — and this document states the difference rather
than hiding it behind a green test. That trade-off is the general risk discussed
in [0001](0001-store-abstraction.md).

## Verification

Partly verified. Semantics and scoping are covered against `MemoryStore`, and I
confirmed the endpoint by hand against the running app: `?q=refund` returned the
matching message with its conversation title for a participant, and `[]` for a
user outside that conversation ([0015](0015-manual-verification.md)).

The Mongo side — `$text`, the text index, `textScore` ranking — **has not run**;
no Docker (see [0000](0000-overview.md)). The specific thing I would check first
on a live Mongo is that stemming behaves as claimed (`refund` ↔ `refunds`) and
that `explain()` shows the text index being used rather than a collection scan.
