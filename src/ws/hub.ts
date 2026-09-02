import type { Server } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Config } from '../config.ts';
import type { Broker } from '../infra/broker.ts';
import type { Store } from '../store/types.ts';

interface Client {
  socket: WebSocket;
  userId: number;
  /** Conversations this socket has been *authorised* to receive, never the raw request. */
  subs: Set<number>;
  alive: boolean;
  /** Per-conversation timestamp of the last accepted typing frame. */
  lastTypingAt: Map<number, number>;
}

const HEARTBEAT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024;

/**
 * Owns the WebSocket connections attached to *this* process, and delivers
 * whatever arrives from the broker to them.
 *
 * The hub never publishes to its own clients directly. Producers (the HTTP
 * routes, and typing frames) publish to the broker; the hub delivers on the
 * subscription. With one instance that is a no-op indirection; with several it
 * is the only thing that makes the app work at all.
 */
export class Hub {
  #clients = new Set<Client>();
  #wss?: WebSocketServer;
  #heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly broker: Broker,
    private readonly config: Config,
  ) {
    this.broker.subscribe((event) => this.#deliver(event.conversationId, event.payload));
  }

  attach(server: Server): void {
    const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
    this.#wss = wss;

    wss.on('connection', (socket, req) => {
      const userId = parseUserId(req.url);
      if (userId === null) {
        // Without a caller identity there is nothing to authorise against.
        socket.close(4001, 'userId required');
        return;
      }

      const client: Client = {
        socket,
        userId,
        subs: new Set(),
        alive: true,
        lastTypingAt: new Map(),
      };
      this.#clients.add(client);

      socket.on('pong', () => {
        client.alive = true;
      });
      socket.on('message', (raw) => {
        this.#onFrame(client, raw).catch((err) => console.error('[ws] frame failed', err));
      });
      socket.on('error', () => socket.close());
      socket.on('close', () => this.#clients.delete(client));
    });

    // Sockets killed by a dead proxy or a slept laptop never emit 'close'. Left
    // alone they accumulate and get written to forever.
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        if (!client.alive) {
          client.socket.terminate();
          this.#clients.delete(client);
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  async close(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const client of this.#clients) client.socket.terminate();
    this.#clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.#wss) return resolve();
      this.#wss.close(() => resolve());
    });
  }

  /** Test seam: how many sockets this process is holding. */
  get connectionCount(): number {
    return this.#clients.size;
  }

  async #onFrame(client: Client, raw: RawData): Promise<void> {
    let frame: { type?: unknown; conversationIds?: unknown; conversationId?: unknown };
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return; // malformed frames are ignored, as before
    }

    if (frame.type === 'subscribe' && Array.isArray(frame.conversationIds)) {
      const requested = new Set(frame.conversationIds.map(Number).filter(Number.isInteger));
      // The old hub trusted the client's list outright, so any socket could ask
      // for conversation 1 and receive other people's messages. Intersect with
      // what this user actually belongs to.
      const allowed = await this.store.conversationIdsForUser(client.userId);
      client.subs = new Set(allowed.filter((id) => requested.has(id)));
      send(client.socket, { type: 'subscribed', conversationIds: [...client.subs] });
      return;
    }

    if (frame.type === 'typing') {
      const conversationId = Number(frame.conversationId);
      if (!Number.isInteger(conversationId) || !client.subs.has(conversationId)) return;

      // The browser throttles to one frame per 1.5s, but nothing stops a client
      // that does not. Measured before this guard: 2000 frames sent, 2000 fanned
      // out to every subscriber — one socket amplified across the whole room,
      // through Redis, with no limit. Client-side throttling is a UX nicety; the
      // server has to enforce it.
      const now = Date.now();
      const last = client.lastTypingAt.get(conversationId) ?? 0;
      if (now - last < this.config.typingMinIntervalMs) return;
      client.lastTypingAt.set(conversationId, now);

      await this.broker.publish({
        conversationId,
        payload: {
          type: 'typing',
          conversationId,
          userId: client.userId,
          expiresAt: Date.now() + this.config.typingTtlMs,
        },
      });
    }
  }

  #deliver(conversationId: number, payload: unknown): void {
    const data = JSON.stringify(payload);
    const authorUserId = (payload as { type?: string; userId?: number }).userId;
    const isTyping = (payload as { type?: string }).type === 'typing';

    for (const client of this.#clients) {
      if (!client.subs.has(conversationId)) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      // Echoing "you are typing" back to the typist is noise.
      if (isTyping && client.userId === authorUserId) continue;
      client.socket.send(data);
    }
  }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function parseUserId(url: string | undefined): number | null {
  const raw = new URL(url ?? '/', 'http://placeholder').searchParams.get('userId');
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
