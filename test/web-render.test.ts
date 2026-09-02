import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/**
 * Renders the real `web/app.js` in a DOM and asserts that user-controlled text
 * is never parsed as markup. See docs/0011-xss-in-sidebar.md.
 *
 * The client is a plain script with no module boundary, so it is loaded by
 * evaluating it in a JSDOM window with `fetch` and `WebSocket` stubbed. That is
 * slightly awkward, but it exercises the shipped file rather than a copy of it.
 */

const XSS_TITLE = '<img src=x onerror="globalThis.__pwned = true">';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | undefined;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  /** Drives a server frame into the client. */
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

interface Client {
  dom: JSDOM;
  window: any;
  document: Document;
  socket(): FakeWebSocket;
  flush(): Promise<void>;
}

async function mountClient(routes: Record<string, unknown>): Promise<Client> {
  const root = path.resolve(import.meta.dirname, '..', 'web');
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const script = await fs.readFile(path.join(root, 'app.js'), 'utf8');

  // runScripts: 'dangerously' so the injected script executes inside the JSDOM
  // realm. The page's own <script src="/app.js"> is never fetched — no resource
  // loader is configured — so the file is injected below instead, after stubs.
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  });
  const window = dom.window as any;

  window.fetch = async (input: string) => {
    const url = String(input).split('?')[0];
    const payload = routes[url] ?? routes[String(input)] ?? [];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  window.WebSocket = FakeWebSocket;
  window.crypto ??= {};
  window.crypto.randomUUID = () => 'test-uuid';

  const tag = window.document.createElement('script');
  tag.textContent = script;
  window.document.body.appendChild(tag);

  const client: Client = {
    dom,
    window,
    document: window.document,
    socket: () => FakeWebSocket.last!,
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
  await client.flush();
  return client;
}

describe('web client rendering', () => {
  let client: Client;

  afterEach(() => client?.dom.window.close());

  describe('conversation titles are not markup', () => {
    beforeEach(async () => {
      client = await mountClient({
        '/api/conversations': [{ id: 1, title: XSS_TITLE, messageCount: 3, lastMessage: null }],
      });
    });

    it('renders a hostile title as text, not as an element', () => {
      const sidebar = client.document.getElementById('conversations')!;

      // The bug: `li.innerHTML = \`<span>${c.title}...\`` parsed this into a
      // real <img> whose onerror ran for every participant.
      assert.equal(sidebar.querySelectorAll('img').length, 0);
      assert.equal(client.window.__pwned, undefined);
      assert.ok(sidebar.textContent!.includes(XSS_TITLE), 'the literal text is shown');
    });

    it('still renders the surrounding structure', () => {
      const items = client.document.querySelectorAll('#conversations li');
      assert.equal(items.length, 1);
      assert.ok(items[0].textContent!.includes('(3)'), 'message count is rendered');
    });
  });

  describe('message bodies are not markup', () => {
    beforeEach(async () => {
      client = await mountClient({
        '/api/conversations': [{ id: 1, title: 'Room', messageCount: 0, lastMessage: null }],
        '/api/messages': {
          messages: [
            { id: 1, conversationId: 1, senderId: 2, body: '<script>globalThis.__pwned = true</script>' },
          ],
          nextBefore: null,
        },
      });
    });

    it('renders a hostile body as text', async () => {
      (client.document.querySelector('#conversations li') as HTMLElement).click();
      await client.flush();

      const pane = client.document.getElementById('messages')!;
      assert.equal(pane.querySelectorAll('script').length, 0);
      assert.equal(client.window.__pwned, undefined);
      assert.ok(pane.textContent!.includes('<script>'));
    });
  });

  describe('search results are not markup', () => {
    beforeEach(async () => {
      client = await mountClient({
        '/api/conversations': [{ id: 1, title: 'Room', messageCount: 0, lastMessage: null }],
        '/api/search': [
          { messageId: 1, conversationId: 1, conversationTitle: XSS_TITLE, senderId: 2, body: XSS_TITLE },
        ],
      });
    });

    it('renders hostile titles and bodies as text', async () => {
      const form = client.document.getElementById('searchForm') as HTMLFormElement;
      (client.document.getElementById('search') as HTMLInputElement).value = 'x';
      form.dispatchEvent(new client.window.Event('submit'));
      await client.flush();

      const pane = client.document.getElementById('messages')!;
      assert.equal(pane.querySelectorAll('img').length, 0);
      assert.equal(client.window.__pwned, undefined);
    });
  });

  describe('typing indicator', () => {
    beforeEach(async () => {
      client = await mountClient({
        '/api/conversations': [{ id: 1, title: 'Room', messageCount: 0, lastMessage: null }],
        '/api/messages': { messages: [], nextBefore: null },
      });
      (client.document.querySelector('#conversations li') as HTMLElement).click();
      await client.flush();
    });

    it('shows a banner while the signal is live', () => {
      client.socket().deliver({
        type: 'typing',
        conversationId: 1,
        userId: 2,
        expiresAt: Date.now() + 5000,
      });

      const banner = client.document.getElementById('typing')!;
      assert.equal(banner.hidden, false);
      assert.match(banner.textContent!, /is typing/);
    });

    it('hides the banner once the signal has expired, with no stop frame', () => {
      client.socket().deliver({
        type: 'typing',
        conversationId: 1,
        userId: 2,
        expiresAt: Date.now() - 1,
      });

      // renderTyping() prunes lapsed entries; this is the property that makes a
      // lost "stop" impossible — see docs/0008-typing-indicator.md.
      const banner = client.document.getElementById('typing')!;
      assert.equal(banner.hidden, true);
      assert.equal(banner.textContent, '');
    });
  });

  describe('live messages', () => {
    beforeEach(async () => {
      client = await mountClient({
        '/api/conversations': [{ id: 1, title: 'Room', messageCount: 0, lastMessage: null }],
        '/api/messages': { messages: [], nextBefore: null },
      });
      (client.document.querySelector('#conversations li') as HTMLElement).click();
      await client.flush();
    });

    it('appends an incoming message once, even if the frame is replayed', () => {
      const frame = { type: 'message', id: 7, conversationId: 1, senderId: 2, body: 'hello' };
      client.socket().deliver(frame);
      client.socket().deliver(frame);

      const rendered = client.document.querySelectorAll('#messages .msg');
      assert.equal(rendered.length, 1, 'a replayed frame does not paint a duplicate');
    });
  });
});
