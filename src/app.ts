import express from 'express';
import type { Config } from './config.ts';
import { asyncHandler, errorHandler } from './http/errors.ts';
import type { Broker } from './infra/broker.ts';
import type { RateLimiter } from './infra/rate-limit.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { messagesRouter } from './routes/messages.ts';
import { searchRouter } from './routes/search.ts';
import type { Store } from './store/types.ts';

export interface AppDeps {
  store: Store;
  broker: Broker;
  rateLimiter: RateLimiter;
  config: Config;
}

/**
 * Builds the Express app from its dependencies and stops there — no listening,
 * no process-wide singletons. That is what lets the tests spin up a complete
 * app per case against in-memory infrastructure.
 */
export function createApp({ store, broker, rateLimiter, config }: AppDeps): express.Express {
  const app = express();

  app.use(express.json({ limit: '64kb' }));
  app.use(express.static('web'));

  // Liveness: the process is running and its event loop is turning.
  app.get('/livez', (_req, res) => {
    res.json({ ok: true, instanceId: config.instanceId });
  });

  // Readiness: the instance can actually serve. Reporting ok while MySQL is
  // down — the previous behaviour — keeps a useless instance in the load
  // balancer's rotation while every real request 500s.
  app.get(
    '/healthz',
    asyncHandler(async (_req, res) => {
      try {
        await store.ping();
      } catch (err) {
        console.error('[health] store unreachable', err);
        res.status(503).json({ ok: false, instanceId: config.instanceId, error: 'store unreachable' });
        return;
      }
      res.json({ ok: true, instanceId: config.instanceId });
    }),
  );

  app.use('/api/conversations', conversationsRouter(store, config));
  app.use('/api/messages', messagesRouter(store, broker, rateLimiter, config));
  app.use('/api/search', searchRouter(store, config));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Must be last: this is where every asyncHandler rejection lands.
  app.use(errorHandler());

  return app;
}
