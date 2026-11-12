import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { type BackupRecord, readBackup } from '../domain/backups/schema.ts';
import { featuresFor } from '../domain/catalog/features.ts';
import type { FeatureItem } from '../domain/catalog/types.ts';
import { db } from '../infra/storage/db.ts';
import { useCarStore } from '../state/car-store.ts';

export function useFeatures(): FeatureItem[] {
  const selection = useCarStore((s) => s.selection);
  return useMemo(() => featuresFor(selection), [selection]);
}

/** Newest-first backups, live: the list updates itself as a session writes its record. */
export function useBackups(): BackupRecord[] | undefined {
  return useLiveQuery(async () => {
    const rows = await db().backups.orderBy('createdAt').reverse().toArray();
    return rows.map(readBackup).filter((r): r is BackupRecord => r !== undefined);
  }, []);
}

// `prepared` = outcome never recorded; a restore then either finds the original (nothing to do) or the change.
const RESTORABLE: readonly BackupRecord['status'][] = ['verified', 'unconfirmed', 'prepared'];

/** An automatic backup that can still be put back: an apply, not yet undone, made by this app version's rules. */
export const canRestore = (b: BackupRecord): boolean =>
  b.operation === 'apply' && !!b.recipeDigest && RESTORABLE.includes(b.status);

/**
 * The backup a feature's page may offer to put back: made over a real adapter connection, on the car this
 * browser is set up for (same VIN fingerprint), for one of the feature's ids. When the feature was changed
 * several times since it was last put back, the OLDEST of those changes holds the car's true original — a
 * later change's "before" is only the previous change. Nothing otherwise.
 */
export function pickRestorable(
  backups: readonly BackupRecord[] | undefined,
  featureIds: readonly string[],
  fingerprint: string | undefined,
): BackupRecord | undefined {
  if (!fingerprint || !backups) return undefined;
  const mine = backups.filter(
    (b) =>
      b.linkMode !== 'demo' && // records left by an older simulated-car mode are never real
      b.vin.fingerprint === fingerprint &&
      featureIds.includes(b.featureId),
  );
  const lastRestore =
    mine
      .filter((b) => b.operation === 'restore' && (b.status === 'verified' || b.status === 'unconfirmed'))
      .map((b) => b.createdAt)
      .sort()
      .at(-1) ?? '';
  return mine
    .filter((b) => canRestore(b) && b.createdAt > lastRestore)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

export function useRestorableBackup(featureIds: readonly string[]): BackupRecord | undefined {
  const backups = useBackups();
  const fingerprint = useCarStore((s) => s.pairing?.fingerprint);
  return pickRestorable(backups, featureIds, fingerprint);
}

/** The current time in ms, ticking every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Whole seconds since `startIso`, ticking while `active`. */
export function useElapsedSeconds(startIso: string | undefined, active: boolean): number {
  const now = useNow(active);
  return startIso ? Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000)) : 0;
}
