import { segmentDiagnosticPdu } from '@obdcraft/obd-core';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BackupFileError,
  type BackupRecord,
  boundTxFrames,
  MAX_TX_FRAMES,
  serializeBackup,
  type TxFrameEntry,
} from '../../domain/backups/schema.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import { DexieBackupStore } from './backup-store.ts';
import { ObdcraftDb } from './db.ts';

const sample = (over: Partial<BackupRecord> = {}): BackupRecord => ({
  schema: 'vibecode-my-car.backup/2',
  operation: 'apply',
  linkMode: 'demo',
  ack: 'unknown',
  history: [],
  id: 'backup-0001',
  createdAt: '2026-10-24T12:00:00.000Z',
  updatedAt: '2026-10-24T12:00:00.000Z',
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
  status: 'prepared',
  ...over,
});

let counter = 0;
let store: DexieBackupStore;
beforeEach(() => {
  const db = new ObdcraftDb(`test-${counter++}`);
  store = new DexieBackupStore(() => db);
});

const hex = (bytes: readonly number[]) =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const frame = (data: string, n = 0): TxFrameEntry => ({
  can: '773',
  data,
  stage: 'submitted',
  at: new Date(Date.UTC(2026, 9, 25, 12, 0, 0, n)).toISOString(),
});

describe('DexieBackupStore — TX evidence capacity (C3.4)', () => {
  it('stores every frame of the largest bundled payload plus its preparation, through real storage', async () => {
    const recipe = APP_DATA.recipes['csmqb-mib3-sound-signature'];
    const payload = recipe?.choices?.[0]?.payload;
    if (!recipe?.did || !payload) throw new Error('fixture: the bundled sound preset is missing');
    const request = segmentDiagnosticPdu(
      [0x2e, ...(`${recipe.did}${payload}`.match(/../g) ?? []).map((b) => Number.parseInt(b, 16))],
      'native',
    );
    expect(request).toHaveLength(294);
    // Sessions, reads, seed/key, markers, identity restores and flow control around it.
    const preparation = Array.from({ length: 60 }, (_, i) => frame('0210030000000000', i));
    const frames = [...preparation, ...request.map((f, i) => frame(hex(f), 60 + i)), frame('021102', 400)];
    await store.save(sample());
    await store.update('backup-0001', {
      status: 'unconfirmed',
      outcome: 'pending-uncertain',
      updatedAt: '2026-10-25T12:01:00.000Z',
      ...boundTxFrames(frames),
    });
    const stored = await store.get('backup-0001');
    expect(stored?.txFrames).toHaveLength(355);
    expect(stored?.txFramesOmitted).toBeUndefined();
    expect(stored?.txFrames?.at(-1)).toMatchObject({ data: '021102' });
  });

  it('keeps the head and the tail, and says how many it left out, when a sequence reports more than it holds', async () => {
    const frames = Array.from({ length: MAX_TX_FRAMES + 100 }, (_, i) =>
      frame(i.toString(16).padStart(4, '0').toUpperCase(), i),
    );
    const bounded = boundTxFrames(frames);
    expect(bounded.txFrames).toHaveLength(MAX_TX_FRAMES);
    expect(bounded.txFramesOmitted).toBe(100);
    expect(bounded.txFrames[0]).toBe(frames[0]);
    expect(bounded.txFrames.at(-1)).toBe(frames.at(-1)); // the last attempted frame survives
    await store.save(sample());
    await store.update('backup-0001', {
      status: 'unconfirmed',
      updatedAt: '2026-10-25T12:01:00.000Z',
      ...bounded,
    });
    expect((await store.get('backup-0001'))?.txFramesOmitted).toBe(100);
    // Unbounded input is refused at the storage boundary rather than stored silently.
    await expect(
      store.update('backup-0001', {
        status: 'unconfirmed',
        updatedAt: '2026-10-25T12:02:00.000Z',
        txFrames: frames,
      }),
    ).rejects.toThrow();
  });

  it('still reads frames journaled as bare hex by earlier builds', async () => {
    await store.save(sample({ txFrames: ['10082E0A5E3E0000', '2100000000000000'] }));
    expect((await store.get('backup-0001'))?.txFrames).toEqual(['10082E0A5E3E0000', '2100000000000000']);
  });
});

describe('DexieBackupStore', () => {
  it('saves and reads back a backup', async () => {
    await store.save(sample());
    expect(await store.get('backup-0001')).toMatchObject({ before: '3A00000000', status: 'prepared' });
  });

  it('refuses to overwrite an existing id', async () => {
    await store.save(sample());
    await expect(store.save(sample({ before: '3B00000000' }))).rejects.toThrow();
    expect((await store.get('backup-0001'))?.before).toBe('3A00000000');
  });

  it('refuses to persist a record that breaks the schema', async () => {
    await expect(store.save(sample({ before: 'nothex' }))).rejects.toThrow();
  });

  it('updates status in place and errors on a missing id', async () => {
    await store.save(sample());
    await store.update('backup-0001', {
      status: 'verified',
      updatedAt: '2026-10-24T12:01:00.000Z',
      observed: '3E00000000',
    });
    expect(await store.get('backup-0001')).toMatchObject({ status: 'verified', observed: '3E00000000' });
    await expect(
      store.update('nope', { status: 'refused', updatedAt: '2026-10-24T12:01:00.000Z' }),
    ).rejects.toThrow(/not found/);
  });

  it('appends every status change to history and never rewrites earlier entries', async () => {
    await store.save(sample({ history: [{ at: '2026-10-24T12:00:00.000Z', status: 'prepared' }] }));
    await store.update('backup-0001', {
      status: 'unconfirmed',
      outcome: 'pending-uncertain',
      ack: 'not-received',
      updatedAt: '2026-10-24T12:01:00.000Z',
    });
    await store.update('backup-0001', {
      status: 'verified',
      outcome: 'observed-match',
      observed: '3E00000000',
      readbackAt: '2026-10-24T12:02:00.000Z',
      updatedAt: '2026-10-24T12:02:00.000Z',
    });
    const b = await store.get('backup-0001');
    expect(b).toMatchObject({ status: 'verified', outcome: 'observed-match', ack: 'not-received' });
    expect(b?.history).toEqual([
      { at: '2026-10-24T12:00:00.000Z', status: 'prepared' },
      { at: '2026-10-24T12:01:00.000Z', status: 'unconfirmed', outcome: 'pending-uncertain' },
      { at: '2026-10-24T12:02:00.000Z', status: 'verified', outcome: 'observed-match' },
    ]);
  });

  it('lists newest first', async () => {
    await store.save(sample({ id: 'backup-old1', createdAt: '2026-10-23T09:00:00.000Z' }));
    await store.save(sample({ id: 'backup-new1', createdAt: '2026-10-24T09:00:00.000Z' }));
    expect((await store.list()).map((b) => b.id)).toEqual(['backup-new1', 'backup-old1']);
  });

  it('removes a backup', async () => {
    await store.save(sample());
    await store.remove('backup-0001');
    expect(await store.list()).toEqual([]);
  });
});

describe('importFile — user-supplied files are untrusted', () => {
  it('round-trips an exported backup', async () => {
    const result = await store.importFile(serializeBackup(sample()));
    expect(result.kind).toBe('added');
    expect((await store.list())[0]?.id).toBe('backup-0001');
  });

  it('reports two simultaneous imports of the same file as added + already present, never a raw error', async () => {
    const file = serializeBackup(sample());
    const results = await Promise.all([store.importFile(file), store.importFile(file)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['added', 'already-present']);
    expect(await store.list()).toHaveLength(1);
  });

  it('does not duplicate or overwrite an id it already has', async () => {
    await store.save(sample({ status: 'verified' }));
    const result = await store.importFile(serializeBackup(sample({ status: 'prepared' })));
    expect(result.kind).toBe('already-present');
    expect((await store.get('backup-0001'))?.status).toBe('verified');
  });

  it.each([
    ['not JSON', 'definitely not json'],
    ['wrong shape', JSON.stringify({ hello: 'world' })],
    ['wrong schema id', JSON.stringify({ ...sample(), schema: 'other/1' })],
    ['extra fields', JSON.stringify({ ...sample(), extra: 1 })],
    ['non-hex bytes', JSON.stringify(sample({ before: 'ZZ' }))],
    ['length mismatch', JSON.stringify(sample({ intended: '3E00' }))],
  ])('rejects %s with a friendly error', async (_n, text) => {
    await expect(store.importFile(text)).rejects.toBeInstanceOf(BackupFileError);
    expect(await store.list()).toEqual([]);
  });
});

describe('records saved under the old app name (obdcraft.backup/2)', () => {
  it('lists, updates and re-saves a stored old-name record under the current id', async () => {
    const db = new ObdcraftDb(`old-name-${counter++}`);
    const old = new DexieBackupStore(() => db);
    await db.backups.put({ ...sample(), schema: 'obdcraft.backup/2' } as unknown as BackupRecord);
    expect((await old.list()).map((b) => b.schema)).toEqual(['vibecode-my-car.backup/2']);
    await old.update('backup-0001', { status: 'verified', updatedAt: '2026-10-24T12:01:00.000Z' });
    expect((await db.backups.get('backup-0001'))?.schema).toBe('vibecode-my-car.backup/2');
  });

  it('loads an old-name backup file', async () => {
    const result = await store.importFile(JSON.stringify({ ...sample(), schema: 'obdcraft.backup/2' }));
    expect(result).toMatchObject({ kind: 'added', record: { schema: 'vibecode-my-car.backup/2' } });
  });
});

describe('schema v1 → v2 migration', () => {
  const v1Row = () => {
    const { operation: _o, linkMode: _l, ack: _a, history: _h, ...rest } = sample({ status: 'verified' });
    return { ...rest, schema: 'obdcraft.backup/1' };
  };

  it('upgrades stored v1 rows as evidence-incomplete, keeping their bytes and status', async () => {
    const name = `migrate-${counter++}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({ backups: 'id, createdAt, status, featureId' });
    await legacy.table('backups').add(v1Row());
    legacy.close();

    const upgraded = new DexieBackupStore(() => new ObdcraftDb(name));
    const b = await upgraded.get('backup-0001');
    expect(b).toMatchObject({
      schema: 'vibecode-my-car.backup/2',
      status: 'verified',
      before: '3A00000000',
      operation: 'apply',
      ack: 'unknown',
      linkMode: 'unknown',
    });
    expect(b?.outcome).toBeUndefined();
    expect(b?.history).toHaveLength(1);
  });

  it('imports a v1 file in the current format', async () => {
    const result = await store.importFile(JSON.stringify(v1Row()));
    expect(result.record).toMatchObject({ schema: 'vibecode-my-car.backup/2', ack: 'unknown' });
  });
});
