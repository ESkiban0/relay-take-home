import Redis from 'ioredis';
import type { Config } from '../config.ts';

/**
 * Redis connections, with deliberately different settings for the two roles.
 *
 * **Command connections** (publisher, rate limiter) must fail fast. ioredis
 * defaults to `enableOfflineQueue: true`, so while Redis is unreachable every
 * command is buffered and the caller's promise never settles — measured against
 * a stopped Redis, `POST /api/messages` hung indefinitely and connections piled
 * up behind it. A bounded `commandTimeout` with the offline queue off turns
 * that into a fast, visible 500.
 *
 * **The subscriber must not.** Its one command is a `SUBSCRIBE` issued at boot,
 * usually *before* the socket is ready — with the offline queue disabled that
 * is rejected outright with "Stream isn't writeable", and the instance then
 * never receives anything at all. Applying the fail-fast options to both roles
 * silently killed all cross-instance real-time; the unit tests could not see it
 * because they run against `MemoryBroker`. So the subscriber keeps the queue
 * and has no command timeout: it is long-lived and has nobody waiting on it.
 *
 * Both keep retrying the connection forever, which is what makes recovery after
 * a Redis restart automatic.
 */
export type RedisRole = 'command' | 'subscriber';

export function redisClient(config: Config, label: string, role: RedisRole): Redis {
  const client = new Redis(
    config.redisUrl,
    role === 'command'
      ? {
          commandTimeout: config.redisCommandTimeoutMs,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        }
      : {
          // Queue the boot-time SUBSCRIBE until the connection is up.
          enableOfflineQueue: true,
          maxRetriesPerRequest: null,
        },
  );

  client.on('error', (err) => {
    // Logged, not thrown: without a listener ioredis reports "Unhandled error
    // event" on every reconnect attempt, which during an outage is a tight loop
    // of noise and, on an EventEmitter, a crash waiting to happen.
    console.error(`[redis:${label}] ${(err as Error).message}`);
  });

  return client;
}
