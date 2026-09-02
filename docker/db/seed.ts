import { config } from '../../src/config.ts';
import { connectMongo, ensureMongoIndexes } from '../../src/db/mongo.ts';

const { client, db } = await connectMongo(config.mongoUrl, config.mongoServerSelectionTimeoutMs);

// The text index backs GET /api/search. Creating it here as well as on API boot
// means a fresh volume is searchable before the first request arrives.
await ensureMongoIndexes(db);

const bodies = db.collection('message_bodies');
await bodies.deleteMany({});
await bodies.insertMany([
  {
    _id: 1 as never,
    conversationId: 1,
    senderId: 2,
    body: 'Hi, any update on order #1042?',
    createdAt: new Date(),
  },
  {
    _id: 2 as never,
    conversationId: 1,
    senderId: 1,
    body: 'Checking now — give me a minute.',
    createdAt: new Date(),
  },
  {
    _id: 3 as never,
    conversationId: 2,
    senderId: 3,
    body: 'Notes from the design sync are in the doc.',
    createdAt: new Date(),
  },
]);

console.log('seeded message bodies');
await client.close();
process.exit(0);
