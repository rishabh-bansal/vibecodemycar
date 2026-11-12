import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Like, D1Statement } from '../src/worker.ts';

/** D1's statement API over node:sqlite, with the real migrations applied: the Worker's SQL runs for real. */
export function sqliteD1(): D1Like & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  for (const m of ['0001_init.sql', '0002_collectors_sessions.sql', '0003_device_status.sql', '0004_items_vin.sql'])
    db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8'));
  const statement = (sql: string, values: unknown[] = []): D1Statement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => ((db.prepare(sql).get(...(values as never[])) as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(values as never[])),
  });
  return { db, prepare: (sql: string) => statement(sql) };
}
