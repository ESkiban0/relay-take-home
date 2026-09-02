import http from 'node:http';
import { createApp } from './app.ts';
import { config as defaultConfig, type Config } from './config.ts';
import { createBroker, type Broker } from './infra/broker.ts';
import { createRateLimiter, type RateLimiter } from './infra/rate-limit.ts';
import { createStore } from './store/index.ts';
import type { Store } from './store/types.ts';
import { Hub } from './ws/hub.ts';

export interface RunningServer {
  server: http.Server;
  hub: Hub;
  store: Store;
  broker: Broker;
  rateLimiter: RateLimiter;
  config: Config;
  stop(): Promise<void>;
}

/**
 * Wires the object graph, starts listening, and hands back everything needed to
 * shut it down again. Kept separate from `index.ts` so tests and the in-memory
 * dev script can start a real server without inheriting signal handlers.
 */
export async function startServer(config: Config = defaultConfig): Promise<RunningServer> {
  const store = await createStore(config);
  const broker = createBroker(config);
  const rateLimiter = createRateLimiter(config);

  const app = createApp({ store, broker, rateLimiter, config });
  const server = http.createServer(app);
  const hub = new Hub(store, broker, config);
  hub.attach(server);

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(
    `relay listening on :${config.port} ` +
      `[instance ${config.instanceId} store=${config.storeDriver} broker=${config.brokerDriver}]`,
  );

  return {
    server,
    hub,
    store,
    broker,
    rateLimiter,
    config,
    async stop() {
      // Order matters, and getting it wrong hangs forever.
      //
      // `server.close()` stops accepting new connections, but its callback does
      // not fire until every *existing* connection has ended — and a WebSocket
      // never ends on its own. Closing the server first therefore waits on
      // sockets that nothing is going to close, until the orchestrator gives up
      // and sends SIGKILL. Drop the sockets first, then the listener.
      //
      // Covered by scripts/verify-shutdown.ts, which fails if this is reversed.
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([broker.close(), rateLimiter.close(), store.close()]);
    },
  };
}
