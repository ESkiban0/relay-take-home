/**
 * Relay web client.
 *
 * There is still no login — the user is picked from `?userId=`, defaulting to 1
 * — but the identity now travels in an `x-user-id` header on every call and on
 * the WebSocket handshake, so the server has something to authorise against.
 */
const userId = Number(new URLSearchParams(location.search).get('userId')) || 1;

const state = {
  conversations: [],
  activeConversation: null,
  /** Oldest loaded message id, used as the paging cursor. */
  nextBefore: null,
  /** conversationId -> Map<userId, expiresAt> */
  typing: new Map(),
  ws: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  typingSentAt: 0,
  sending: false,
};

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': String(userId),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const error = new Error(payload.error || `request failed (${res.status})`);
    error.status = res.status;
    error.retryAfter = Number(res.headers.get('Retry-After')) || null;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------------------------------------------ inbox */

async function loadConversations() {
  state.conversations = await api(`/api/conversations`);
  renderSidebar();
  connectWs();
}

function renderSidebar() {
  const list = el('conversations');
  list.replaceChildren();

  for (const c of state.conversations) {
    const li = document.createElement('li');
    if (c.id === state.activeConversation) li.className = 'active';

    // Built as text nodes, never innerHTML: a conversation titled
    // `<img src=x onerror=...>` used to execute here for everyone in the room.
    const label = document.createElement('span');
    label.textContent = `${c.title} (${c.messageCount})`;
    li.append(label);

    if (c.unread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '●';
      li.append(dot);
    }

    li.onclick = () => openConversation(c.id, c.title);
    list.append(li);
  }
}

/* ------------------------------------------------------------- websocket */

function connectWs() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  clearTimeout(state.reconnectTimer);

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/?userId=${userId}`);
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectAttempts = 0;
    setStatus('');
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        conversationIds: state.conversations.map((c) => c.id),
      }),
    );
  };

  ws.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (frame.type === 'message') onIncomingMessage(frame);
    if (frame.type === 'typing') onTyping(frame);
  };

  // The original client opened one socket and never noticed it dying: after a
  // proxy restart or a laptop waking up, the app looked fine and silently
  // stopped receiving anything.
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  const attempt = ++state.reconnectAttempts;
  const delay = Math.min(30000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
  setStatus('Reconnecting…');
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(async () => {
    try {
      // Refresh the inbox first: anything missed while offline is in there.
      state.conversations = await api('/api/conversations');
      renderSidebar();
    } catch {
      /* still offline; connectWs will fail and back off again */
    }
    connectWs();
  }, delay);
}

function onIncomingMessage(msg) {
  const conversation = state.conversations.find((c) => c.id === msg.conversationId);
  if (conversation) conversation.messageCount += 1;

  if (msg.conversationId === state.activeConversation) {
    appendMessage(msg);
  } else if (conversation) {
    conversation.unread = true;
  }
  renderSidebar();
}

/* --------------------------------------------------------------- messages */

async function openConversation(id, title) {
  state.activeConversation = id;
  const conversation = state.conversations.find((c) => c.id === id);
  if (conversation) conversation.unread = false;
  renderSidebar();

  el('title').textContent = title;
  const pane = el('messages');
  pane.replaceChildren();

  const { messages, nextBefore } = await api(`/api/messages?conversationId=${id}`);
  state.nextBefore = nextBefore;
  renderOlderControl();
  for (const m of messages) appendMessage(m);
  renderTyping();
}

async function loadOlder() {
  if (!state.activeConversation || state.nextBefore === null) return;
  const { messages, nextBefore } = await api(
    `/api/messages?conversationId=${state.activeConversation}&before=${state.nextBefore}`,
  );
  state.nextBefore = nextBefore;

  const pane = el('messages');
  const previousHeight = pane.scrollHeight;
  for (const m of [...messages].reverse()) pane.prepend(renderMessage(m));
  renderOlderControl();
  pane.scrollTop = pane.scrollHeight - previousHeight;
}

function renderOlderControl() {
  el('older').hidden = state.nextBefore === null;
}

function renderMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.dataset.messageId = String(m.id);
  const who = document.createElement('strong');
  who.textContent = `#${m.senderId}`;
  div.append(who, `: ${m.body}`);
  return div;
}

function appendMessage(m) {
  const pane = el('messages');
  // The server de-duplicates retried sends, but a reconnect can replay a frame
  // the pane already shows.
  if (pane.querySelector(`[data-message-id="${m.id}"]`)) return;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  pane.append(renderMessage(m));
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

/* ---------------------------------------------------------------- typing */

function onTyping({ conversationId, userId: who, expiresAt }) {
  if (!state.typing.has(conversationId)) state.typing.set(conversationId, new Map());
  state.typing.get(conversationId).set(who, expiresAt);
  renderTyping();
}

function renderTyping() {
  const banner = el('typing');
  const now = Date.now();
  const live = state.typing.get(state.activeConversation) ?? new Map();

  for (const [who, expiresAt] of live) if (expiresAt <= now) live.delete(who);

  const names = [...live.keys()].map((id) => `#${id}`);
  banner.textContent = names.length
    ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`
    : '';
  banner.hidden = names.length === 0;
}

// Signals expire on their own, so a client that closes its tab mid-sentence
// does not leave a stuck "is typing…" behind.
setInterval(renderTyping, 1000);

function notifyTyping() {
  const now = Date.now();
  if (!state.activeConversation || state.ws?.readyState !== WebSocket.OPEN) return;
  // Throttled: one frame per 1.5s, not one per keystroke.
  if (now - state.typingSentAt < 1500) return;
  state.typingSentAt = now;
  state.ws.send(JSON.stringify({ type: 'typing', conversationId: state.activeConversation }));
}

/* ----------------------------------------------------------------- forms */

function setStatus(text) {
  const status = el('status');
  status.textContent = text;
  status.hidden = !text;
}

el('text').addEventListener('input', notifyTyping);
el('older').onclick = () => loadOlder().catch((err) => setStatus(err.message));

el('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = el('text');
  const body = input.value.trim();
  if (!body || !state.activeConversation || state.sending) return;

  state.sending = true;
  input.value = '';
  try {
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: state.activeConversation,
        body,
        // Stable per send: a retry of *this* message carries the same id and is
        // de-duplicated server-side rather than posting twice.
        clientId: crypto.randomUUID(),
      }),
    });
    setStatus('');
  } catch (err) {
    // Put the text back so a rate-limited message is not simply lost.
    input.value = body;
    setStatus(
      err.status === 429
        ? `Sending too fast — try again in ${err.retryAfter ?? 10}s.`
        : err.message,
    );
  } finally {
    state.sending = false;
  }
};

el('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title) return;
  try {
    await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title, participantIds: [userId, 2] }),
    });
    await loadConversations();
  } catch (err) {
    setStatus(err.message);
  }
};

el('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = el('search').value.trim();
  if (!q) return;
  try {
    renderResults(q, await api(`/api/search?q=${encodeURIComponent(q)}`));
  } catch (err) {
    setStatus(err.message);
  }
};

function renderResults(q, results) {
  state.activeConversation = null;
  state.nextBefore = null;
  renderOlderControl();
  renderTyping();
  el('title').textContent = `Search: "${q}"`;

  const pane = el('messages');
  pane.replaceChildren();

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'msg muted';
    empty.textContent = 'No results.';
    pane.append(empty);
    return;
  }

  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'msg result';
    const title = document.createElement('strong');
    title.textContent = r.conversationTitle || `#${r.conversationId}`;
    div.append(title, ` — ${r.body ?? ''}`);
    div.onclick = () =>
      openConversation(r.conversationId, r.conversationTitle || `#${r.conversationId}`);
    pane.append(div);
  }
}

loadConversations().catch((err) => setStatus(err.message));
