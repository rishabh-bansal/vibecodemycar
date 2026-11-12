import { BUILD_INFO } from '../../config/build.ts';
import { type BackupRecord, BackupSchema, parseBackupFile, readBackup } from '../../domain/backups/schema.ts';
import type { BackupPatch, BackupStore } from '../../domain/coding/types.ts';
import { type ObdcraftDb, db as sharedDb } from './db.ts';

export type ImportResult = { kind: 'added' | 'already-present'; record: BackupRecord };

/** IndexedDB-backed backups. `save` resolves only after the transaction commits. */
export class DexieBackupStore implements BackupStore {
  private readonly database: () => ObdcraftDb;

  constructor(database: () => ObdcraftDb = sharedDb) {
    this.database = database;
  }

  /** Saves a new journal, stamped with the build that recorded it (unless it already names one). */
  async save(backup: BackupRecord): Promise<void> {
    await this.add({
      ...backup,
      build: backup.build ?? {
        buildId: import.meta.env?.VITE_BUILD_ID || 'development',
        gitSha: BUILD_INFO.gitSha || 'unknown',
        version: BUILD_INFO.version || 'unknown',
      },
    });
  }

  private async add(backup: BackupRecord): Promise<void> {
    // Re-validate at the storage boundary: a bug upstream must not persist junk we cannot later restore from.
    const valid = BackupSchema.parse(backup);
    await this.database().backups.add(valid);
  }

  /** Applies the patch and appends one history entry, atomically. Earlier history is never rewritten. */
  async update(id: string, patch: BackupPatch): Promise<void> {
    const database = this.database();
    await database.transaction('rw', database.backups, async () => {
      const current = readBackup(await database.backups.get(id));
      if (!current) throw new Error(`backup ${id} not found`);
      const next = BackupSchema.parse({
        ...current,
        ...patch,
        history: [
          ...current.history,
          { at: patch.updatedAt, status: patch.status, ...(patch.outcome ? { outcome: patch.outcome } : {}) },
        ],
      });
      await database.backups.put(next);
    });
  }

  async get(id: string): Promise<BackupRecord | undefined> {
    return readBackup(await this.database().backups.get(id));
  }

  /** Newest first. Rows that no longer match any known schema are skipped rather than crashing the list. */
  async list(): Promise<BackupRecord[]> {
    const rows = await this.database().backups.orderBy('createdAt').reverse().toArray();
    return rows.map(readBackup).filter((r): r is BackupRecord => r !== undefined);
  }

  async remove(id: string): Promise<void> {
    await this.database().backups.delete(id);
  }

  /** Load a backup file the user chose. Validated first; an existing id is never overwritten. */
  async importFile(text: string): Promise<ImportResult> {
    const record = parseBackupFile(text);
    const existing = await this.get(record.id);
    if (existing) return { kind: 'already-present', record: existing };
    try {
      // An imported record keeps the build it names (or none): this build did not record it.
      await this.add(record);
    } catch (error) {
      // Two imports of the same file racing: the second add hits the existing key.
      const raced =
        error instanceof Error && error.name === 'ConstraintError' ? await this.get(record.id) : undefined;
      if (raced) return { kind: 'already-present', record: raced };
      throw error;
    }
    return { kind: 'added', record };
  }
}
