import mysql, { type Pool } from 'mysql2/promise';

/**
 * A pool per call rather than a module-level singleton: a singleton created at
 * import time dials MySQL from every process that so much as imports a route,
 * which is exactly what made the old code impossible to test in isolation.
 */
export function createPool(url: string): Pool {
  return mysql.createPool(url);
}

export async function waitForMysql(pool: Pool, retries = 40, delayMs = 1500): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`mysql not reachable: ${lastErr}`);
}
