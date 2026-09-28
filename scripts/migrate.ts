import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { closePool, pool } from '../src/lib/db';

export async function migrate(dir = path.resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations')): Promise<string[]> {
  const db = pool();
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    const done = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = await readFile(path.join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`migration ${f} changed after it was applied; add a new migration instead`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    client.release();
  }
  return applied;
}

const isMain = process.argv[1] && /migrate\.(ts|mjs|js)$/.test(process.argv[1]);
if (isMain) {
  migrate()
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date'))
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
