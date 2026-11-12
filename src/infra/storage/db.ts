import Dexie, { type EntityTable } from 'dexie';
import { type BackupRecord, readBackup } from '../../domain/backups/schema.ts';
import type { ExperimentRecord } from '../../domain/coding/audit.ts';
import type { ConnectionLog } from '../../domain/logs/redact.ts';
import type { OutboxEntry } from '../cloud/outbox.ts';

/**
 * Local database. Everything stays on the user's device — there is no account
 * and no server. Bump the version and add an `.upgrade()` for any schema change;
 * never edit a published version in place.
 */
export class ObdcraftDb extends Dexie {
  backups!: EntityTable<BackupRecord, 'id'>;
  experiments!: EntityTable<ExperimentRecord, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'key'>;
  connectionLogs!: EntityTable<ConnectionLog, 'id'>;

  constructor(name = 'obdcraft') {
    super(name);
    this.version(1).stores({
      // Only indexed fields are listed; the rest of the record is stored as-is.
      backups: 'id, createdAt, status, featureId',
    });
    // v2: operation journal (outcome, ACK evidence, link mode, history). v1 rows are migrated as
    // evidence-incomplete; a row no known schema accepts is left untouched rather than destroyed.
    this.version(2)
      .stores({ backups: 'id, createdAt, status, featureId, operation' })
      .upgrade((tx) =>
        tx
          .table('backups')
          .toCollection()
          .modify((row, ref) => {
            const migrated = readBackup(row);
            if (migrated) ref.value = migrated;
          }),
      );
    this.version(3).stores({
      backups: 'id, createdAt, status, featureId, operation',
      experiments: 'id, startedAt, featureId, state',
    });
    // v4: the private cloud log outbox. Upload state only; the records stay in their own tables.
    this.version(4).stores({
      backups: 'id, createdAt, status, featureId, operation',
      experiments: 'id, startedAt, featureId, state',
      outbox: 'key, status, nextAttemptAt',
    });
    // v5: the connection command log (every adapter line and app stage of a connection; serial numbers blanked at capture).
    this.version(5).stores({
      backups: 'id, createdAt, status, featureId, operation',
      experiments: 'id, startedAt, featureId, state',
      outbox: 'key, status, nextAttemptAt',
      connectionLogs: 'id, startedAt, session',
    });
    // v6: `updatedAt` on every logged record, so the cloud outbox scans only what changed since its last scan.
    this.version(6).stores({
      backups: 'id, createdAt, status, featureId, operation, updatedAt',
      experiments: 'id, startedAt, featureId, state, updatedAt',
      outbox: 'key, status, nextAttemptAt',
      connectionLogs: 'id, startedAt, session, updatedAt',
    });
  }
}

let shared: ObdcraftDb | undefined;
export const db = (): ObdcraftDb => {
  shared ??= new ObdcraftDb();
  return shared;
};

/**
 * Ask the browser not to evict our data under storage pressure. Backups are the
 * user's undo button; losing them silently would defeat the point. Best effort —
 * some browsers decide for themselves.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
