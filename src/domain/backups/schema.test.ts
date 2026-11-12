import { describe, expect, it } from 'vitest';
import { fingerprintVin, vinRecord } from '../vin.ts';
import {
  type BackupRecord,
  BackupSchema,
  backupFileName,
  parseBackupFile,
  readBackup,
  serializeBackup,
} from './schema.ts';

const apply: BackupRecord = {
  schema: 'vibecode-my-car.backup/2',
  id: 'backup-0001',
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  featureId: 'comfort-lane-change-indicator-5-flashes',
  featureName: 'Comfort lane change',
  recipeId: 'live-bcm-polite-blinks',
  settingId: 'value-5',
  settingLabel: '5 blinks',
  car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
  vin: { masked: 'MEXK…1234', fingerprint: 'a'.repeat(64) },
  module: { request: '70E', response: '778', part: '2Q0937089D' },
  did: '0A5E',
  before: '3A00000000',
  intended: '3E00000000',
  status: 'verified',
  operation: 'apply',
  linkMode: 'demo',
  ack: 'received',
  history: [],
};

describe('backup record invariants', () => {
  it('accepts a well-formed apply and restore', () => {
    expect(BackupSchema.safeParse(apply).success).toBe(true);
    expect(
      BackupSchema.safeParse({ ...apply, id: 'restore-001', operation: 'restore', restoreOf: apply.id })
        .success,
    ).toBe(true);
  });

  it.each([
    ['a restore that does not name what it restores', { operation: 'restore' as const }],
    ['an apply that claims to restore something', { restoreOf: 'backup-0002' }],
    ['before and intended of different lengths', { intended: '3E000000' }],
    ['a mask that does not cover the block', { ownedMask: '16' }],
  ])('rejects %s', (_why, change) => {
    expect(BackupSchema.safeParse({ ...apply, ...change }).success).toBe(false);
  });

  it('applies the same rules to records read from storage and from files', () => {
    const broken = { ...apply, intended: '3E000000' };
    expect(readBackup(broken)).toBeUndefined();
    expect(() => parseBackupFile(JSON.stringify(broken))).toThrow(/isn't a valid Vibecode my car backup/);
  });

  it('validates a migrated v1 record against the current invariants', () => {
    const {
      operation: _o,
      linkMode: _l,
      ack: _a,
      history: _h,
      ...v1
    } = { ...apply, schema: 'obdcraft.backup/1' };
    expect(readBackup(v1)).toMatchObject({
      schema: 'vibecode-my-car.backup/2',
      operation: 'apply',
      ack: 'unknown',
    });
    expect(readBackup({ ...v1, intended: '3E' })).toBeUndefined();
  });
});

describe('backups saved under the old app name (OBDCraft)', () => {
  it('loads an obdcraft.backup/2 file and gives it the current id', () => {
    const old = { ...apply, schema: 'obdcraft.backup/2' };
    const loaded = parseBackupFile(JSON.stringify(old));
    expect(loaded).toEqual({ ...apply, schema: 'vibecode-my-car.backup/2' });
    expect(serializeBackup(loaded)).toContain('"schema": "vibecode-my-car.backup/2"');
  });

  it('reads an obdcraft.backup/2 record from storage', () => {
    expect(readBackup({ ...apply, schema: 'obdcraft.backup/2' })?.schema).toBe('vibecode-my-car.backup/2');
  });

  it('still refuses a file of some other format', () => {
    expect(() => parseBackupFile(JSON.stringify({ ...apply, schema: 'obdcraft.backup/3' }))).toThrow(
      /isn't a valid Vibecode my car backup/,
    );
    expect(() => parseBackupFile('not json')).toThrow("That file isn't a Vibecode my car backup.");
  });

  it('names new backup files vibecode-my-car-backup-<model>-<date>.json', () => {
    expect(backupFileName({ ...apply, createdAt: '2026-11-11T13:45:07.000Z' })).toBe(
      'vibecode-my-car-backup-kushaq-20261111-134507.json',
    );
  });
});

describe('2026-11 additions stay backward compatible', () => {
  const step = {
    index: 0,
    recipeId: 'teardrop-p1',
    module: { request: '70E', response: '778', part: '2Q0937089D' },
    did: '0A72',
    before: '0000',
    intended: '0004',
    ownedMask: '0004',
    action: 'apply' as const,
    status: 'verified' as const,
  };

  it('still reads a record written before groups, variants and advisory readiness existed', () => {
    expect(
      readBackup({ ...apply, readiness: { at: apply.createdAt, rpm: 0, speedKmh: 0, voltage: 12.6 } }),
    ).toBeDefined();
  });

  it('accepts unreadable readiness values with the warning that was shown', () => {
    const readiness = { at: apply.createdAt, rpm: null, speedKmh: 0, voltage: null, warning: 'Car check: …' };
    expect(BackupSchema.safeParse({ ...apply, readiness, warnings: ['other car'], variant: 1 }).success).toBe(
      true,
    );
  });

  it('accepts a group record whose parts each carry their own module, DID, bytes and mask', () => {
    const group = {
      ...apply,
      groupId: 'group:teardrop',
      stepIndex: 0,
      steps: [
        step,
        {
          ...step,
          index: 1,
          did: '6001',
          before: '000000',
          intended: '000020',
          ownedMask: '000020',
          status: 'planned',
        },
      ],
    };
    expect(BackupSchema.safeParse(group).success).toBe(true);
    expect(readBackup(JSON.parse(JSON.stringify(group)))?.steps).toHaveLength(2);
  });

  it.each([
    ['a part whose mask does not cover its block', { steps: [{ ...step, ownedMask: '04' }] }],
    ['a part listed twice', { steps: [step, step] }],
    ['a mirrored part that is not in the group', { stepIndex: 3, steps: [step] }],
  ])('rejects %s', (_why, change) => {
    expect(BackupSchema.safeParse({ ...apply, groupId: 'group:teardrop', ...change }).success).toBe(false);
  });
});

describe('the full VIN', () => {
  it('is kept alongside the masked VIN and fingerprint, and survives a file round trip', async () => {
    const vin = await vinRecord(' tmbjb7ns0p8012345 ');
    expect(vin).toEqual({
      masked: 'TMBJ…2345',
      fingerprint: await fingerprintVin('TMBJB7NS0P8012345'),
      full: 'TMBJB7NS0P8012345',
    });
    const record = { ...apply, vin };
    expect(parseBackupFile(serializeBackup(record)).vin.full).toBe('TMBJB7NS0P8012345');
  });

  it('is optional: a record saved before it was kept still reads (current and v1 formats)', () => {
    expect(readBackup(apply)?.vin.full).toBeUndefined();
    const {
      operation: _o,
      linkMode: _l,
      ack: _a,
      history: _h,
      ...v1
    } = { ...apply, schema: 'obdcraft.backup/1' };
    expect(readBackup(v1)).toBeDefined();
    expect(readBackup({ ...v1, vin: { ...apply.vin, full: 'TMBJB7NS0P8012345' } })?.vin.full).toBe(
      'TMBJB7NS0P8012345',
    );
  });

  it('must be stored upper-case without spaces', () => {
    expect(BackupSchema.safeParse({ ...apply, vin: { ...apply.vin, full: 'tmb jb7' } }).success).toBe(false);
    expect(BackupSchema.safeParse({ ...apply, vin: { ...apply.vin, full: '' } }).success).toBe(false);
  });
});
