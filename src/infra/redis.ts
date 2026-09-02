import Redis from 'ioredis';
import type { Config } from '../config.ts';

/**
 * One place that builds Redis connections, because the defaults are wrong for
 * this app in two ways that only show up during an outage.
 *
 * **Commands must not queue forever.** ioredis defaults to
 * `enableOfflineQueue: true`, so while Redis is unreachable every command is
 * buffered and the caller's promise simply never settles. Measured against a
 * stopped Redis, `POST /api/messages` hung indefinitely — the request never
 * returned at all, and connections piled up behind it. A bounded
 * `commandTimeout` turns that into a fast, visible failure.
 *
 * **An unhandled `error` event is a crash risk.** Without a listener, ioredis
 * logs `Unhandled error event` on every reconnect attempt, which during a real
 * outage is a tight loop of noise, and on an EventEmitter is one refactor away
 * from taking the process down.
 *
 * The connection itself still retries forever — that is what makes recovery
 * after a restart automatic, which is verified in docs/0017.
 */
export function redisClient(config: Config, label: string): Redis {
  const client = new Redis(config.redisUrl, {
    commandTimeout: config.redisCommandTimeoutMs,
    // Fail a command rather than parking it until Redis returns.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  client.on('error', (err) => {
    // Logged, not thrown: the caller sees the failed command, and the
    // connection keeps retrying underneath.
    console.error(`[redis:${label}] ${(err as Error).message}`);
  });

  return client;
}
