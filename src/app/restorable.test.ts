import { describe, expect, it } from 'vitest';
import type { BackupRecord } from '../domain/backups/schema.ts';
import { canRestore, pickRestorable } from './hooks.ts';

const CAR = 'a'.repeat(64);
const backup = (over: Partial<BackupRecord>): BackupRecord =>
  ({
    id: 'b1',
    createdAt: '2026-10-01T10:00:00.000Z',
    featureId: 'comfort-turn-signals',
    operation: 'apply',
    status: 'verified',
    linkMode: 'live',
    recipeDigest: 'f'.repeat(64),
    vin: { masked: 'MEXK…1234', fingerprint: CAR },
    ...over,
  }) as BackupRecord;

describe('which backup a feature page may offer to put back', () => {
  const ids = ['comfort-turn-signals', 'comfort-lane-change-indicator-5-flashes'];

  it('only a not-yet-undone apply made under the current rules', () => {
    expect(canRestore(backup({}))).toBe(true);
    expect(canRestore(backup({ status: 'restored' }))).toBe(false);
    expect(canRestore(backup({ status: 'refused' }))).toBe(false);
    expect(canRestore(backup({ operation: 'restore' }))).toBe(false);
    expect(canRestore(backup({ recipeDigest: undefined }))).toBe(false);
  });

  it('the oldest change since the last undo, of this feature, on this car, from a real car', () => {
    const older = backup({ id: 'old', createdAt: '2026-09-01T10:00:00.000Z' });
    const newer = backup({ id: 'new', featureId: 'comfort-lane-change-indicator-5-flashes' });
    // Two changes in a row: only the first one's "before" is the car's original (live 2026-11-02, 0A69).
    expect(pickRestorable([newer, older], ids, CAR)?.id).toBe('old');
    // After an undo, only changes made since then count.
    const undo = backup({ id: 'undo', operation: 'restore', createdAt: '2026-09-15T10:00:00.000Z' });
    expect(pickRestorable([older, undo, newer], ids, CAR)?.id).toBe('new');
    expect(pickRestorable([older, undo], ids, CAR)).toBeUndefined();
    expect(pickRestorable([older], ids, 'b'.repeat(64))).toBeUndefined();
    expect(pickRestorable([older], ids, undefined)).toBeUndefined();
    expect(pickRestorable([older], ['another-feature'], CAR)).toBeUndefined();
    expect(pickRestorable([backup({ linkMode: 'demo' })], ids, CAR)).toBeUndefined();
    expect(pickRestorable(undefined, ids, CAR)).toBeUndefined();
  });
});
