/**
 * Acceptance cases from the independent review of 2026-10-24 (docs/reviews/2026-10-24/REVIEW.md),
 * kept with their original adversarial inputs and positive control, plus the neighbouring cases each
 * fix has to hold. Simulated I/O only — no Bluetooth, no vehicle.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { type BackupRecord, parseBackupFile } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { findFeature } from '../catalog/features.ts';
import type { Recipe } from '../catalog/schema.ts';
import { CodingController } from './controller.ts';
import { recipeDigest } from './plan.ts';
import { type CodingDeps, isQuarantined, runSession } from './run.ts';
import type { BackupStore, CodingEvent, CodingRequest, DidWrite } from './types.ts';

const car = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
} as const;
const found = findFeature(car, 'comfort-lane-change-indicator-5-flashes');
if (!found) throw new Error('fixture feature missing');
const feature = found;
const request: CodingRequest = { kind: 'apply', car, feature, settingId: 'value-5' };

function fixture(mode: 'demo' | 'live' = 'demo') {
  const link = new SimulatedCar({
    mode,
    parts: { '70E': '2Q0937089D' },
    values: { '70E:0A5E': '3A00000000' },
  });
  const records = new Map<string, BackupRecord>();
  let saves = 0;
  const deps: CodingDeps = {
    link,
    signal: new AbortController().signal,
    newId: () => `backup-${++saves}`,
    sleep: async () => {},
    readbackDelayMs: 0,
    backups: {
      save: async (b) => {
        records.set(b.id, structuredClone(b));
      },
      update: async (id, p) => {
        const b = records.get(id);
        if (!b) throw new Error('missing');
        records.set(id, { ...b, ...p, history: [...b.history, { at: p.updatedAt, status: p.status }] });
      },
    },
  };
  return { link, records, deps };
}

async function run(req: CodingRequest, deps: CodingDeps) {
  const events: CodingEvent[] = [];
  for await (const e of runSession(req, deps)) events.push(e);
  return events;
}
const refusal = (events: CodingEvent[]) => events.find((e) => e.type === 'refused');

/** Apply once, then hand back the saved backup with the wire log cleared. */
async function applied(mode: 'demo' | 'live' = 'demo') {
  const f = fixture(mode);
  await run(request, f.deps);
  const backup = f.records.get('backup-1');
  if (!backup) throw new Error('apply did not save a backup');
  f.link.writes.length = 0;
  return { ...f, backup };
}

it('control: exact readback plus ACK succeeds once', async () => {
  const f = fixture();
  const events = await run(request, f.deps);
  expect(events.at(-1)).toMatchObject({ outcome: 'verified' });
  expect(f.link.writes).toHaveLength(1);
});

describe('A1 — restore is bound to the exact target it was made against', () => {
  it('refuses when the current recipe DID differs from the saved DID (review repro)', async () => {
    const f = await applied();
    f.link.values.set('70E:BEEF', '3E00000000');
    const moved = { ...APP_DATA.recipes[f.backup.recipeId], did: 'BEEF' } as Recipe;
    const events = await run({ kind: 'restore', backup: f.backup }, { ...f.deps, recipeFor: () => moved });
    expect(f.link.writes, 'must not write backup bytes to the replacement recipe target').toHaveLength(0);
    expect(refusal(events)).toMatchObject({ reason: 'target-changed' });
  });

  it('refuses when the module response address changed', async () => {
    const f = await applied();
    const moved = { ...APP_DATA.recipes[f.backup.recipeId], responseId: '77F' } as Recipe;
    const events = await run({ kind: 'restore', backup: f.backup }, { ...f.deps, recipeFor: () => moved });
    expect(f.link.writes).toHaveLength(0);
    expect(refusal(events)).toMatchObject({ reason: 'target-changed' });
  });

  it('refuses when the definition changed under the same id and DID (digest mismatch)', async () => {
    const f = await applied();
    const base = APP_DATA.recipes[f.backup.recipeId] as Recipe;
    const revised = { ...base, password: '00000' } as Recipe;
    expect(await recipeDigest(revised)).not.toBe(f.backup.recipeDigest);
    const events = await run({ kind: 'restore', backup: f.backup }, { ...f.deps, recipeFor: () => revised });
    expect(f.link.writes).toHaveLength(0);
    expect(refusal(events)).toMatchObject({ reason: 'target-changed' });
  });

  it('refuses to overwrite a later change (conflict), and writes nothing', async () => {
    const f = await applied();
    f.link.values.set('70E:0A5E', '3600000000'); // someone set it to another value since
    const events = await run({ kind: 'restore', backup: f.backup }, f.deps);
    expect(f.link.writes).toHaveLength(0);
    expect(refusal(events)).toMatchObject({ reason: 'restore-conflict' });
    expect(f.records.size).toBe(1);
  });

  it('positive: restores an unchanged target and records the digest it used', async () => {
    const f = await applied();
    expect(f.backup.recipeDigest).toMatch(/^[0-9a-f]{64}$/);
    const events = await run({ kind: 'restore', backup: f.backup }, f.deps);
    expect(events.at(-1)).toMatchObject({ outcome: 'verified' });
    expect(f.link.writes).toEqual([expect.objectContaining({ did: '0A5E', bytes: '3A00000000' })]);
  });
});

describe('A2 — restore is durable before its write', () => {
  it('requires a durable attempt record before its write (review repro)', async () => {
    const f = await applied();
    const brokenStore: BackupStore = {
      save: async () => {
        throw Error('disk unavailable');
      },
      update: async () => {
        throw Error('disk unavailable');
      },
    };
    const events = await run({ kind: 'restore', backup: f.backup }, { ...f.deps, backups: brokenStore });
    expect(f.link.writes, 'a restore must not bypass durable-before-write').toHaveLength(0);
    expect(refusal(events)).toMatchObject({ reason: 'backup-failed' });
  });

  it('saves current bytes and intent as a new linked record before the write leaves', async () => {
    const f = await applied();
    const atWire: BackupRecord[] = [];
    const send = f.link.writeDid.bind(f.link);
    f.link.writeDid = async (...args) => {
      atWire.push(...[...f.records.values()].filter((r) => r.operation === 'restore'));
      return send(...args);
    };
    await run({ kind: 'restore', backup: f.backup }, f.deps);
    expect(atWire).toEqual([
      expect.objectContaining({
        restoreOf: 'backup-1',
        before: '3E00000000',
        intended: '3A00000000',
        status: 'prepared',
      }),
    ]);
    // The original apply's own history is appended to, never rewritten.
    const source = f.records.get('backup-1');
    expect(source?.status).toBe('restored');
    expect(source?.history.slice(0, f.backup.history.length)).toEqual(f.backup.history);
  });

  it('reports — never hides — a storage failure after the write, with an exportable record', async () => {
    const f = fixture();
    f.deps = {
      ...f.deps,
      backups: {
        save: f.deps.backups.save,
        update: async () => {
          throw Error('quota exceeded');
        },
      },
    };
    const events = await run(request, f.deps);
    const audit = events.find((e) => e.type === 'audit-failed');
    expect(audit).toMatchObject({
      backupId: 'backup-1',
      record: { status: 'verified', outcome: 'verified', ack: 'received' },
    });
    // The car-side outcome is still the truthful one, and arrives after the audit notice.
    expect(events.at(-1)).toMatchObject({ type: 'outcome', outcome: 'verified' });
  });
});

describe('B — an expired write retires the link', () => {
  it('timed-out write cannot overlap a second operation on the same live link (review repro)', async () => {
    const f = fixture('live'); // synthetic I/O with live policy enabled; no Bluetooth is used
    let active = 0;
    let peak = 0;
    const finish: (() => void)[] = [];
    f.link.writeDid = async () => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<DidWrite>((resolve) =>
        finish.push(() => {
          active--;
          resolve({ kind: 'no-reply' });
        }),
      );
    };
    const controller = new CodingController((signal) => ({ ...f.deps, signal, writeDeadlineMs: 10 }));
    await controller.start(request).done;
    let second: Promise<unknown> | undefined;
    try {
      second = controller.start(request).done;
    } catch {
      /* refusing while unquiesced is acceptable */
    }
    if (second) await second;
    for (const done of finish) done();
    expect(peak, 'deadline must quarantine/close the old link before another operation').toBeLessThanOrEqual(
      1,
    );
  });

  it('closes the link, refuses every later session on it (including recheck), and ignores late callbacks', async () => {
    const f = fixture('live');
    let late: ((r: DidWrite) => void) | undefined;
    let pending: (() => void) | undefined;
    f.link.writeDid = (_m, _d, _b, opts) => {
      pending = opts.onPending;
      return new Promise<DidWrite>((resolve) => {
        late = resolve;
      });
    };
    const first = await run(request, { ...f.deps, writeDeadlineMs: 10 });
    expect(first.at(-1)).toMatchObject({ outcome: 'pending-uncertain' });
    expect(isQuarantined(f.link)).toBe(true);
    expect(f.link.closed).toBe(true);

    // Late frames from the abandoned exchange change nothing.
    pending?.();
    late?.({ kind: 'acked' });
    await Promise.resolve();
    expect(f.records.get('backup-1')).toMatchObject({ status: 'unconfirmed', outcome: 'pending-uncertain' });

    const backup = f.records.get('backup-1') as BackupRecord;
    for (const req of [request, { kind: 'recheck', backup } as const, { kind: 'restore', backup } as const]) {
      expect(refusal(await run(req, f.deps))).toMatchObject({ reason: 'link-quarantined' });
    }
  });

  it('a recheck on a fresh connection still works after the deadline', async () => {
    const f = fixture('live');
    f.link.writeDid = () => new Promise<DidWrite>(() => {});
    await run(request, { ...f.deps, writeDeadlineMs: 10 });
    const fresh = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3E00000000' } });
    const backup = f.records.get('backup-1') as BackupRecord;
    const events = await run({ kind: 'recheck', backup }, { ...f.deps, link: fresh });
    expect(events.at(-1)).toMatchObject({ outcome: 'observed-match' });
    expect(fresh.writes).toHaveLength(0);
  });
});

describe('C — the durable record keeps the evidence', () => {
  it('durable result preserves missing ACK rather than collapsing it into verified (review repro)', async () => {
    const f = fixture();
    f.link.writeDid = async (module, did, bytes) => {
      f.link.values.set(`${module.request}:${did}`, bytes);
      return { kind: 'pending-no-final' };
    };
    const events = await run(request, f.deps);
    expect(events.at(-1)).toMatchObject({ outcome: 'observed-match' });
    const record = [...f.records.values()][0];
    expect(record, 'reloaded/exported record must preserve the outcome distinction').toHaveProperty(
      'outcome',
      'observed-match',
    );
    expect(record).toMatchObject({ ack: 'not-received', linkMode: 'demo', observed: '3E00000000' });
    expect(record?.readbackAt).toBeDefined();
  });

  it('survives an export/import round trip', async () => {
    const f = fixture();
    f.link.writeDid = async (module, did, bytes) => {
      f.link.values.set(`${module.request}:${did}`, bytes);
      return { kind: 'pending-no-final' };
    };
    await run(request, f.deps);
    const reloaded = parseBackupFile(JSON.stringify(f.records.get('backup-1')));
    expect(reloaded).toMatchObject({ outcome: 'observed-match', ack: 'not-received' });
    expect(reloaded.history.map((h) => h.status)).toEqual(['prepared', 'verified']);
  });

  it('a v1 file migrates as evidence-incomplete, never as ACK-confirmed or live', () => {
    const {
      schema: _s,
      operation: _o,
      linkMode: _l,
      ack: _a,
      history: _h,
      recipeDigest: _d,
      ...rest
    } = {
      ...([...fixtureRecord()][0] as BackupRecord),
    };
    const v1 = { ...rest, schema: 'obdcraft.backup/1', status: 'verified' };
    const migrated = parseBackupFile(JSON.stringify(v1));
    expect(migrated).toMatchObject({
      schema: 'vibecode-my-car.backup/2',
      ack: 'unknown',
      linkMode: 'unknown',
    });
    expect(migrated.outcome).toBeUndefined();
    expect(migrated.recipeDigest).toBeUndefined();
  });
});

describe('D — the domain writes what the catalogue maps (no tier, safety or setting-list gate)', () => {
  it('an "unavailable" tier is not a gate: the mapped recipe is written (owner directive 2026-11-01)', async () => {
    const f = fixture();
    const events = await run(
      { ...request, feature: { ...feature, tier: 'unavailable', reason: 'not-mapped' } } as CodingRequest,
      { ...f.deps, featureFor: () => ({ ...feature, tier: 'unavailable', reason: 'not-mapped' }) },
    );
    expect(f.link.writes).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ outcome: 'verified' });
  });

  it('refuses a request whose recipe differs from the catalogue mapping', async () => {
    const f = fixture();
    const other = Object.keys(APP_DATA.recipes).find((id) => id !== feature.recipeId) as string;
    const events = await run({ ...request, feature: { ...feature, recipeId: other } }, f.deps);
    expect(f.link.writes).toHaveLength(0);
    expect(refusal(events)).toMatchObject({ reason: 'not-eligible' });
  });

  it('refuses a setting the recipe does not declare (the planner, before any backup)', async () => {
    const f = fixture();
    const events = await run({ ...request, settingId: 'value-99' }, f.deps);
    expect(f.link.writes).toHaveLength(0);
    expect(f.records.size).toBe(0);
    expect(refusal(events)).toMatchObject({ reason: 'invalid-plan' });
  });

  it('writes a protected-safety recipe; refuses only a recipe with no bytes to write', async () => {
    const base = APP_DATA.recipes[feature.recipeId as string] as Recipe;
    const safety = fixture();
    const written = await run(request, {
      ...safety.deps,
      recipeFor: () => ({ ...base, protectedSafety: true }) as never,
    });
    expect(written.at(-1)).toMatchObject({ outcome: 'verified' });
    const empty = fixture();
    const noBytes = {
      id: base.id,
      name: base.name,
      kind: 'ops',
      unit: '09',
      requestId: '70E',
      responseId: '778',
      password: null,
      executable: false,
      reason: 'no-bytes',
    };
    const events = await run(request, { ...empty.deps, recipeFor: () => noBytes as never });
    expect(refusal(events)).toMatchObject({ reason: 'invalid-plan' });
    expect(empty.link.writes).toHaveLength(0);
  });

  it('a restore does not depend on the catalogue still offering the feature', async () => {
    const f = await applied();
    const events = await run(
      { kind: 'restore', backup: f.backup },
      { ...f.deps, featureFor: () => ({ ...feature, tier: 'unavailable', reason: 'not-mapped' }) },
    );
    expect(events.at(-1)).toMatchObject({ outcome: 'verified' });
  });
});

/** A representative v2 record (synchronous) for the migration case. */
function fixtureRecord(): BackupRecord[] {
  return [
    {
      schema: 'vibecode-my-car.backup/2',
      id: 'backup-legacy',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      featureId: feature.id,
      featureName: feature.name,
      recipeId: feature.recipeId as string,
      settingId: 'value-5',
      settingLabel: '5 blinks',
      car,
      vin: { masked: 'MEXS…0001', fingerprint: 'a'.repeat(64) },
      module: { request: '70E', response: '778', part: '2Q0937089D' },
      did: '0A5E',
      before: '3A00000000',
      intended: '3E00000000',
      observed: '3E00000000',
      status: 'verified',
      operation: 'apply',
      linkMode: 'demo',
      ack: 'received',
      history: [],
    },
  ];
}
