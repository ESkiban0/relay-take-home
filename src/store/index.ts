import type { Config } from '../config.ts';
import { connectMongo, ensureMongoIndexes } from '../db/mongo.ts';
import { createPool, waitForMysql } from '../db/mysql.ts';
import { MemoryStore } from './memory.ts';
import { SqlMongoStore } from './sql-mongo.ts';
import type { Store } from './types.ts';

export type { Store } from './types.ts';
export { MemoryStore } from './memory.ts';

export async function createStore(config: Config): Promise<Store> {
  if (config.storeDriver === 'memory') return new MemoryStore();

  const pool = createPool(config.mysqlUrl);
  await waitForMysql(pool);
  const { db } = await connectMongo(config.mongoUrl);
  await ensureMongoIndexes(db);
  return new SqlMongoStore(pool, db);
}
