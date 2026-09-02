export {};

/**
 * Boots the app with the in-memory store and broker, seeded with the same demo
 * data as the Docker stack, so the UI can be clicked through with no MySQL,
 * Mongo or Redis running. Cross-platform: sets env in-process rather than
 * relying on shell-specific `VAR=value cmd` syntax.
 */
process.env.STORE_DRIVER = 'memory';
process.env.BROKER_DRIVER = 'memory';
process.env.INSTANCE_ID = process.env.INSTANCE_ID ?? 'dev-memory';

const { seedDemoData } = await import('./seed-memory.ts');
const { startServer } = await import('../src/server.ts');

const { store } = await startServer();
await seedDemoData(store);
console.log('[dev:memory] demo data seeded — open http://localhost:3000');
