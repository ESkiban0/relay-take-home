import { MongoClient, type Db } from 'mongodb';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(
  url: string,
  /**
   * The driver default is 30 seconds, which turns a Mongo outage into a
   * 30-second hang on every send rather than a fast failure. Measured.
   */
  serverSelectionTimeoutMS = 3000,
  retries = 20,
  delayMs = 1500,
): Promise<MongoHandle> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS });
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await client.connect();
      return { client, db: client.db() };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`mongo not reachable: ${lastErr}`);
}

/**
 * Indexes the app depends on. `createIndex` is idempotent, so this is safe to
 * run on every boot — including from several API instances at once.
 *
 * - the text index backs GET /api/search;
 * - conversationId narrows a search to the caller's own conversations.
 */
export async function ensureMongoIndexes(db: Db): Promise<void> {
  const bodies = db.collection('message_bodies');
  await bodies.createIndex({ body: 'text' }, { name: 'body_text' });
  await bodies.createIndex({ conversationId: 1, _id: -1 }, { name: 'conversation_recent' });
}
