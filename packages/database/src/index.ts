import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export * from './schema.js';

// Pool is lazy: importing this module does not connect or run migrations.
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}
