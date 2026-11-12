/**
 * Durable local storage for the live kit: the app's own Dexie database on fake-indexeddb, snapshotted to
 * <log-dir>/db/obdcraft-live.json so backups and experiments survive across CLI invocations. The stores are
 * the app's (DexieBackupStore; the experiment recorder takes the same `db`), so the writer runs against the
 * exact semantics it has in the browser.
 *
 * Backup saves and updates resolve only after the snapshot is on disk (the BackupStore durability contract).
 * Every other table change is snapshotted shortly after, and `flush()` must run before the process exits.
 */
import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupRecord } from '../../src/domain/backups/schema.ts';
import type { BackupPatch, BackupStore } from '../../src/domain/coding/types.ts';
import { DexieBackupStore } from '../../src/infra/storage/backup-store.ts';
import { ObdcraftDb } from '../../src/infra/storage/db.ts';

const SNAPSHOT_SCHEMA = 'obdcraft.live-db/1';

export interface LiveStore {
  db: ObdcraftDb;
  backups: BackupStore & { get(id: string): Promise<BackupRecord | undefined>; list(): Promise<BackupRecord[]> };
  file: string;
  flush(): Promise<void>;
}

export async function openLiveStore(logDir: string): Promise<LiveStore> {
  const dir = join(logDir, 'db');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'obdcraft-live.json');
  const db = new ObdcraftDb(`obdcraft-live-${process.pid}`);
  await db.open();

  if (existsSync(file)) {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; tables: Record<string, unknown[]> };
    if (snap.schema !== SNAPSHOT_SCHEMA) throw new Error(`${file}: unknown snapshot schema ${snap.schema}`);
    await db.transaction('rw', db.tables, async () => {
      for (const table of db.tables) {
        const rows = snap.tables[table.name];
        if (rows?.length) await table.bulkPut(rows);
      }
    });
  }

  let writing: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    writing = writing.then(async () => {
      const tables: Record<string, unknown[]> = {};
      for (const table of db.tables) tables[table.name] = await table.toArray();
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ schema: SNAPSHOT_SCHEMA, savedAt: new Date().toISOString(), tables }));
      renameSync(tmp, file);
    });
    return writing;
  };

  // Changes made through `db` directly (the experiment recorder) are snapshotted once their transaction settles.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      void flush();
    }, 50);
  };
  for (const table of db.tables) {
    table.hook('creating', soon);
    table.hook('updating', soon);
    table.hook('deleting', soon);
  }

  const dexie = new DexieBackupStore(() => db);
  const backups: LiveStore['backups'] = {
    async save(backup) {
      await dexie.save(backup);
      await flush();
    },
    async update(id: string, patch: BackupPatch) {
      await dexie.update(id, patch);
      await flush();
    },
    get: (id) => dexie.get(id),
    list: () => dexie.list(),
  };

  return {
    db,
    backups,
    file,
    async flush() {
      if (pending) {
        clearTimeout(pending);
        pending = undefined;
      }
      await flush();
    },
  };
}
