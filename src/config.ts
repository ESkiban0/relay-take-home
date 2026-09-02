import crypto from 'node:crypto';

/**
 * `driver: 'memory'` runs the whole app with no MySQL/Mongo/Redis at all. It
 * backs the test suite and `npm run dev:memory`; it is single-process only and
 * loses everything on restart, so it is never the default.
 */
export type Driver = 'sql' | 'memory';

function driver(value: string | undefined, fallback: Driver): Driver {
  return value === 'memory' || value === 'sql' ? value : fallback;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: int(process.env.PORT, 3000),

  storeDriver: driver(process.env.STORE_DRIVER, 'sql'),
  /** 'memory' degrades the app to a single instance — see docs/0007-multi-instance.md. */
  brokerDriver: driver(process.env.BROKER_DRIVER, 'sql'),

  mysqlUrl: process.env.MYSQL_URL || 'mysql://root:root@mysql:3306/relay?charset=utf8mb4',
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017/relay',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',

  /** Distinguishes API instances in logs and in broker frames. */
  instanceId: process.env.INSTANCE_ID || crypto.randomUUID(),

  messagePageSize: int(process.env.MESSAGE_PAGE_SIZE, 50),
  maxMessageLength: int(process.env.MAX_MESSAGE_LENGTH, 4000),
  searchLimit: int(process.env.SEARCH_LIMIT, 50),

  rateLimit: {
    /** Messages allowed per window, per user, per conversation. */
    limit: int(process.env.RATE_LIMIT_MESSAGES, 5),
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 10_000),
  },

  /** How long a `typing` signal stays live before the UI drops it. */
  typingTtlMs: int(process.env.TYPING_TTL_MS, 4000),
};

export type Config = typeof config;
