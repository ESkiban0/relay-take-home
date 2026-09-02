# 0004 — Rejected async handlers left requests hanging forever

**Kind:** bug — reliability
**Touches:** `src/http/errors.ts` (new), all routes, `src/app.ts`

## Symptom

Any database hiccup and the browser sits there spinning. Not an error — no
response at all, until the client's own timeout fires. The server log shows an
`UnhandledPromiseRejection` warning, or in newer Node, the process exits.

## Diagnosis

Every route was an `async` function handed straight to Express:

```js
conversationsRouter.get('/', async (req, res) => {
  const [conversations] = await pool.query(...);   // throws → rejected promise
  res.json(result);
});
```

Express 4 predates promises. It calls the handler and ignores the return value,
so a rejection has nowhere to go: `next(err)` is never called, the error
middleware never runs, and `res` is never written. The request is simply
abandoned with the socket held open.

Two consequences beyond the obvious one. Every hung request holds a connection
and a pool slot, so a brief database blip converts into a much longer outage
while the pool drains. And since Node 15, an unhandled rejection terminates the
process by default — so under `restart: on-failure` the container restarts, and
in-flight WebSocket connections across *all* users drop with it.

Related: the app had no error middleware at all, and no `404` for unknown API
paths. `GET /api/nonsense` fell through to `express.static('web')` and returned
the HTML page with a 200, which is a confusing thing to hand a fetch caller.

## Options

**A. `try/catch` in every handler.** Works, and is explicit. Rejected: it is the
same six lines in every route, and the failure mode is that someone forgets one
— which is precisely the bug being fixed. The compiler cannot catch a missing
`try`.

**B. Upgrade to Express 5.** Express 5 awaits handler return values and routes
rejections to the error middleware natively; this bug does not exist there. This
is genuinely the better long-term answer and I nearly took it. Rejected here
because it is a major version with real breaking changes (path-to-regexp
rewrite, `req.query` getter semantics, removed methods) — a migration that
deserves its own change and its own testing, not a drive-by inside a bug fix. I
would raise it separately.

**C. `express-async-errors`** — a package that monkey-patches Router to do this
globally. Rejected: a dependency that silently rewrites the framework's internals
is a bad trade against ten lines I can read.

**D. An explicit `asyncHandler` wrapper.** Chosen — it is visible at every call
site, has no dependency, and survives an Express 5 upgrade harmlessly.

## What I did

`src/http/errors.ts`:

```ts
export function asyncHandler(handler) {
  return (req, res, next) => { handler(req, res, next).catch(next); };
}
```

Every async route is wrapped. Paired with an error middleware registered last in
`createApp`, which does three things in order:

1. `HttpError` → its own status and message. This is how routes signal `400`,
   `403`, `429` — by throwing, so validation can live in helpers
   (`src/http/validate.ts`) rather than being threaded back through return
   values.
2. **Anything carrying a 4xx `status`/`statusCode`** → that status, passed
   through. This exists because `express.json()` throws a `SyntaxError` with
   `status: 400` on a malformed body; without this branch a client's bad JSON is
   reported as a server fault. I got this wrong on the first pass and the test
   below caught it.
3. Anything else → log it in full server-side, return `{ error: 'internal
   error' }` with a `500`. Internal messages do not go to clients; a stack trace
   or a driver error string is an information leak, and it is the kind that
   accumulates quietly.

Also added: `/healthz` (reports `instanceId`, which is useful when several are
running — [0007](0007-multi-instance.md)), and a JSON `404` for unmatched
`/api/*` so API misses stop returning the HTML shell.

## Tests

`test/http-errors.test.ts` uses an `ExplodingStore` — a `MemoryStore` subclass
whose read throws — which is only possible because the store is injected
([0001](0001-store-abstraction.md)).

- `answers 500 instead of hanging when a handler rejects` — races the request
  against a 2 s timer and **fails if the request hangs**, which is the actual
  symptom. A plain status assertion would hang the test runner instead of
  reporting a failure, so the race is the point.
- `does not leak the internal message to the client` — asserts `'on fire'` does
  not appear in the response.
- `rejects malformed JSON bodies with 400` — the body-parser passthrough. This
  one failed on the first run (it returned `500`) and is why branch 2 exists.
- `returns JSON 404 for unknown API paths rather than the static handler`.

## Verification

Verified. The failure path runs through the real Express stack over real HTTP in
the test suite; nothing here depends on MySQL, Mongo or Redis.
