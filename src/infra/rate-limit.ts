/**
 * Sliding-window rate limiting for message sends.
 *
 * A fixed window (a counter keyed by `floor(now / window)`) is simpler, but it
 * lets a caller send `2 * limit` messages across a window boundary — which is
 * precisely the burst this is meant to stop. A sliding window log keeps one
 * timestamp per allowed call, so the limit holds over *every* window position,
 * and it yields an exact `Retry-After` for free: the oldest entry's expiry.
 *
 * See docs/0006-rate-limiting.md.
 */
import type Redis from 'ioredis';
import type { Config } from '../config.ts';
import { redisClient } from './redis.ts';

export interface RateLimitDecision {
  allowed: boolean;
  /** Calls still available in the current window. */
  remaining: number;
  /** Milliseconds until the next call would be allowed; 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitDecision>;
  close(): Promise<void>;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/**
 * Evaluated atomically inside Redis. Doing ZREMRANGEBYSCORE / ZCARD / ZADD as
 * separate round trips would let concurrent requests all observe the same
 * pre-insert count and sail past the limit together.
 */
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local used = redis.call('ZCARD', key)

if used < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - used - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window - (now - tonumber(oldest[2]))
if retry < 0 then retry = 0 end
redis.call('PEXPIRE', key, window)
return {0, 0, retry}
`;

export class RedisRateLimiter implements RateLimiter {
  #calls = 0;

  constructor(
    private readonly redis: Redis,
    private readonly options: RateLimitOptions,
  ) {
    this.redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
  }

  static create(config: Config): RedisRateLimiter {
    return new RedisRateLimiter(redisClient(config, 'ratelimit', 'command'), config.rateLimit);
  }

  async consume(key: string): Promise<RateLimitDecision> {
    const now = Date.now();
    // Unique per call so two sends in the same millisecond are two ZSET members.
    const member = `${now}-${this.#calls++}`;
    const [allowed, remaining, retryAfterMs] = (await (
      this.redis as unknown as {
        slidingWindow(
          key: string,
          now: string,
          window: string,
          limit: string,
          member: string,
        ): Promise<[number, number, number]>;
      }
    ).slidingWindow(
      `ratelimit:${key}`,
      String(now),
      String(this.options.windowMs),
      String(this.options.limit),
      member,
    )) as [number, number, number];

    return { allowed: allowed === 1, remaining, retryAfterMs };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/** Same algorithm, in process. Only correct for a single instance. */
export class MemoryRateLimiter implements RateLimiter {
  #hits = new Map<string, number[]>();

  constructor(private readonly options: RateLimitOptions) {}

  async consume(key: string): Promise<RateLimitDecision> {
    const now = Date.now();
    const { limit, windowMs } = this.options;
    const kept = (this.#hits.get(key) ?? []).filter((t) => t > now - windowMs);

    if (kept.length < limit) {
      kept.push(now);
      this.#hits.set(key, kept);
      return { allowed: true, remaining: limit - kept.length, retryAfterMs: 0 };
    }

    this.#hits.set(key, kept);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, windowMs - (now - kept[0])),
    };
  }

  async close(): Promise<void> {
    this.#hits.clear();
  }
}

export function createRateLimiter(config: Config): RateLimiter {
  return config.brokerDriver === 'memory'
    ? new MemoryRateLimiter(config.rateLimit)
    : RedisRateLimiter.create(config);
}
