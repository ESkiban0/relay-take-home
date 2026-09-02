# 0011 — Conversation titles were rendered as HTML

**Kind:** bug — security (stored XSS)
**Touches:** `web/app.js`

## Symptom

Create a conversation titled `<img src=x onerror="alert(1)">`. The alert fires —
not only for you, but for every participant, every time they load the app.

## Diagnosis

```js
li.innerHTML =
  `<span>${c.title} (${c.messageCount})</span>` + (c.unread ? '<span class="dot">●</span>' : '');
```

`c.title` is user-supplied, stored verbatim, and interpolated into `innerHTML`.
That is stored XSS: the payload persists in the database and executes in every
participant's browser.

It is worth being clear about severity, because "it's a chat app for three demo
users" undersells it. The injected script runs on the app's origin, so it can
read every conversation the victim can, post as them, and — once there is real
auth — exfiltrate whatever the session is worth. The attacker only needs to be
able to name a conversation. In a product with invites, that is any stranger.

Message bodies were already safe, using `textContent`:

```js
div.textContent = `#${m.senderId}: ${m.body}`;
```

which is what makes this easy to miss. The developer clearly knew; the sidebar
was written in a different sitting.

## Options

**A. Escape the title before interpolating** — a `escapeHtml()` helper replacing
`&<>"'`. Works. Rejected because it keeps `innerHTML` as the rendering
primitive, so correctness depends on every future contributor remembering to
call the helper on every future field. It is a fix that requires vigilance
forever.

**B. Sanitise on input**, cleaning titles before storing. Rejected on principle:
escaping is context-dependent — the correct escaping for HTML text, an HTML
attribute, a URL and JSON are all different — so it belongs at the point of
output, where the context is known. Sanitising on input also destroys the
original data and does nothing about rows already stored.

**C. A sanitiser library (DOMPurify).** The right answer when you must render
user-supplied *markup*. Here nothing renders markup: titles are plain text. A
dependency to strip HTML from strings that should never have been treated as
HTML.

**D. Build the DOM instead of concatenating it.** Chosen — `createElement` +
`textContent`, so the browser never parses user data as markup at all.

**E. A framework with escaping by default** (React, Lit, Vue). Genuinely the
structural answer — this class of bug largely disappears. Rejected as far out of
scope: the frontend is one 300-line file with no build step, and introducing a
framework and a bundler to fix an XSS is not a proportionate trade.

## What I did

```js
const label = document.createElement('span');
label.textContent = `${c.title} (${c.messageCount})`;
li.append(label);

if (c.unread) {
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.textContent = '●';
  li.append(dot);
}
```

`textContent` assigns a text node; the string is never parsed as markup, in any
context. Because the structure is now built rather than concatenated, there is
no template into which a future field could be interpolated unsafely.

I applied the same treatment to every render path I touched rather than only the
one that was exploitable — search results, message rows, the typing banner, the
status line. Nothing in `web/app.js` assigns to `innerHTML` any more; that is a
one-line grep for a reviewer, whereas "every interpolation is escaped" is not
checkable at a glance.

`pane.innerHTML = ''` also became `pane.replaceChildren()`. Not a security fix —
the empty string is harmless — but it removes the last `innerHTML` from the file
so the grep is clean, and it is faster besides.

## What is still missing

**A Content-Security-Policy header.** Defence in depth: even with correct
escaping, a CSP that forbids inline script and restricts sources turns a future
mistake from a full compromise into a blocked console message. Not added here
because doing it properly means auditing the whole page and choosing between
nonces and hashes, which is its own change. It is the first thing I would add
next, and `helmet` would be a reasonable way in.

## Tests

My first pass shipped this fix with no test, on the reasoning that the project
had no DOM test runner and adding one for a single fix was disproportionate.
That was the wrong call: this is a security fix, and "I removed the dangerous
primitive" is an argument, not evidence. So `jsdom` went in as a dev dependency
and `test/web-render.test.ts` loads the real `web/index.html` and the real
`web/app.js` into a DOM, with `fetch` and `WebSocket` stubbed.

- `renders a hostile title as text, not as an element` — serves a conversation
  titled `<img src=x onerror="globalThis.__pwned = true">` and asserts the
  sidebar contains **zero** `<img>` elements, that `__pwned` is `undefined`, and
  that the literal text is displayed.
- `still renders the surrounding structure` — the escaping did not break the
  markup around it.
- `renders a hostile body as text` and `renders hostile titles and bodies as
  text` — the message pane and the search results, which share the same risk.

**I checked that the test actually catches the bug.** Re-introducing the
original line:

```js
li.innerHTML = '<span>' + c.title + ' (' + c.messageCount + ')</span>';
```

fails `renders a hostile title as text` and passes everything else — which is
both the confirmation that it is a real regression test and the confirmation
that the other two paths were already safe. A test for a fix that passes against
the unfixed code is worse than no test.

The same harness also covers rendering behaviour from other changes: the typing
banner appearing and self-expiring ([0008](0008-typing-indicator.md)) and
duplicate-frame suppression ([0012](0012-websocket-reconnect.md)).

## Verification

Verified. The fix is covered by a test that has been demonstrated to fail
against the original code.

It is also confirmed in a real browser engine, not only in jsdom: I created a
conversation titled `<img src=x onerror="document.title=...">` against the
running app and read the live DOM back — zero `<img>` elements in the sidebar,
`document.title` untouched, payload shown as literal text
([0015](0015-manual-verification.md)).

Still open: the Content-Security-Policy header discussed above.
