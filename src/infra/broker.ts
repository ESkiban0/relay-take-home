/**
 * Fan-out of real-time events between API instances.
 *
 * The WebSocket hub can only reach sockets attached to its own process. With
 * more than one API instance behind the proxy, a message accepted by instance A
 * has to reach subscribers parked on instances B and C — that hop is this
 * interface. See docs/0007-multi-instance.md.
 */
import type Redis from 'ioredis';
import type { Config } from '../config.ts';
import { redisClient } from './redis.ts';

export interface BrokerEvent {
  conversationId: number;
  /** Whatever the WS clients should receive, already shaped as a frame. */
  payload: unknown;
  /** Instance that originated the event; present for debugging and loop checks. */
  origin: string;
}

export type BrokerHandler = (event: BrokerEvent) => void;

export interface Broker {
  publish(event: Omit<BrokerEvent, 'origin'>): Promise<void>;
  subscribe(handler: BrokerHandler): void;
  close(): Promise<void>;
}

const CHANNEL = 'relay:events';

/** Single-process fan-out. Correct only while exactly one instance is running. */
export class MemoryBroker implements Broker {
  #handlers = new Set<BrokerHandler>();

  constructor(private readonly origin: string) {}

  async publish(event: Omit<BrokerEvent, 'origin'>): Promise<void> {
    const full: BrokerEvent = { ...event, origin: this.origin };
    for (const handler of this.#handlers) handler(full);
  }

  subscribe(handler: BrokerHandler): void {
    this.#handlers.add(handler);
  }

  async close(): Promise<void> {
    this.#handlers.clear();
  }
}

/**
 * Redis pub/sub fan-out.
 *
 * Note the publisher does *not* deliver locally before publishing: it publishes
 * only, and every instance — including the one that produced the event —
 * delivers when the subscription fires. One code path, so a message cannot be
 * delivered twice locally or dropped on the originating instance.
 */
export class RedisBroker implements Broker {
  #handlers = new Set<BrokerHandler>();
  #started = false;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
    private readonly origin: string,
  ) {}

  static create(config: Config): RedisBroker {
    return new RedisBroker(
      redisClient(config, 'broker:pub'),
      redisClient(config, 'broker:sub'),
      config.instanceId,
    );
  }

  async publish(event: Omit<BrokerEvent, 'origin'>): Promise<void> {
    const full: BrokerEvent = { ...event, origin: this.origin };
    await this.pub.publish(CHANNEL, JSON.stringify(full));
  }

  subscribe(handler: BrokerHandler): void {
    this.#handlers.add(handler);
    if (this.#started) return;
    this.#started = true;

    this.sub.subscribe(CHANNEL).catch((err) => {
      console.error('[broker] subscribe failed', err);
    });
    this.sub.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      let event: BrokerEvent;
      try {
        event = JSON.parse(raw);
      } catch {
        return; // another writer put something unexpected on the channel
      }
      for (const h of this.#handlers) h(event);
    });
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export function createBroker(config: Config): Broker {
  return config.brokerDriver === 'memory'
    ? new MemoryBroker(config.instanceId)
    : RedisBroker.create(config);
}
