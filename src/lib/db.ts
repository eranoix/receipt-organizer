import pg from 'pg';

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends pg.QueryResultRow = Row>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

const g = globalThis as unknown as { __roPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__roPool) {
    g.__roPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgres://receipts:receipts@localhost:5611/receipts',
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    });
  }
  return g.__roPool;
}

export async function q<T extends pg.QueryResultRow = Row>(sql: string, params: unknown[] = [], db: Db = pool()): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function q1<T extends pg.QueryResultRow = Row>(sql: string, params: unknown[] = [], db: Db = pool()): Promise<T | null> {
  return (await db.query<T>(sql, params)).rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (g.__roPool) {
    await g.__roPool.end();
    g.__roPool = undefined;
  }
}
