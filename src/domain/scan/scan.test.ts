import { SafetyPolicy } from '@obdcraft/obd-core';
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { APP_DATA } from '../catalog/data.ts';
import { groupStepsOf, planGroupStep } from '../coding/plan.ts';
import { type CodingDeps, runSession } from '../coding/run.ts';
import type { BackupStore, CarLink, CodingEvent, CodingRecipe, DidRead } from '../coding/types.ts';
import { decodeLampRecord, LAMP_DIDS, lampName } from './lamps.ts';
import { buildCarMap, type ScanReads, type UnitReads } from './map.ts';
import { carMapMarkdown, carMapSummary } from './markdown.ts';
import { IDENTITY_DIDS, readPlan } from './plan.ts';
import { assertReadOnlyRequest, ReadOnlyViolation, readOnlyLink } from './readonly.ts';
import { scanUnits, selectScanUnits } from './units.ts';

const BCM = { request: '70E', response: '778' };

/** The owner's Kushaq BCM lamp records as read live (cloud-log-export.json; REMAINING_FEATURES.md §A.0). */
const KUSHAQ_LAMPS: Record<string, string> = {
  '0550': '0C340014020064000000000000000000',
  '0552': '0448004A14006408091C06009C000000',
  '0553': '044C004C140064080A1C07009C000000',
  '0554': '0144004B14007F080A7F000000000000',
  '0555': '013A004914007F08097F000000000000',
  '055B': '240000003E0064000000000000000000',
  '055C': '0A380022121664000000000000000000',
  '055D': '0A420023131764000000000000000000',
  '0567': '2D0A002908097F000000000000000000',
};

class MemoryBackups implements BackupStore {
  async save() {}
  async update() {}
}

const unitReads = (over: Partial<UnitReads> & Pick<UnitReads, 'unit' | 'module'>): UnitReads => ({
  aliases: [],
  label: over.unit,
  answered: {},
  truncated: {},
  refused: {},
  silent: [],
  pending: [],
  complete: true,
  ...over,
});

const reads = (units: UnitReads[], fitted = units.map((u) => u.module.request)): ScanReads => ({
  startedAt: '2026-11-03T10:00:00.000Z',
  finishedAt: '2026-11-03T10:20:00.000Z',
  vin: 'MEXTEST0SAMPLE042',
  deep: false,
  discovery: scanUnits().map((u) => ({
    unit: u.unit,
    aliases: u.aliases,
    request: u.module.request,
    response: u.module.response,
    label: u.label,
    source: u.source,
    fitted: fitted.includes(u.module.request),
    answer: fitted.includes(u.module.request) ? 'part' : 'unreachable',
  })),
  units,
});

describe('read-only enforcement', () => {
  it('accepts only one-identifier reads, tester present and the default/extended session', () => {
    for (const ok of [
      [0x22, 0xf1, 0x87],
      [0x3e, 0x00],
      [0x3e, 0x80],
      [0x10, 0x01],
      [0x10, 0x03],
    ])
      expect(() => assertReadOnlyRequest(ok)).not.toThrow();
    for (const bad of [
      [0x2e, 0x0a, 0x5e, 0x3e],
      [0x27, 0x03],
      [0x27, 0x04, 1, 2, 3, 4],
      [0x31, 0x01, 0x02, 0x03],
      [0x11, 0x01],
      [0x14, 0xff, 0xff, 0xff],
      [0x10, 0x02],
      [0x10, 0x40],
      [0x22, 0xf1, 0x87, 0xf1, 0x89],
      [0x2f, 0x01],
      [0x34],
      [],
    ])
      expect(() => assertReadOnlyRequest(bad)).toThrow(ReadOnlyViolation);
  });

  it('throws on every write path before it reaches the car, and locks and releases the wire', async () => {
    const car = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3E00A00000' } });
    let locks = 0;
    let released = 0;
    (car as CarLink).lockReadOnly = () => {
      locks += 1;
      return () => {
        released += 1;
      };
    };
    const ro = readOnlyLink(car);
    expect(locks).toBe(1);
    expect(ro.canWrite).toBe(false);
    await expect(
      ro.writeDid(BCM, '0A5E', '3E00A00001', { securityPassword: null, onPending: () => {} }),
    ).rejects.toThrow(ReadOnlyViolation);
    await expect(
      ro.sequence?.(
        BCM,
        { pre: [], post: [], password: null, write: { kind: 'did', did: '0A5E', bytes: '00' } },
        { securityPassword: null, onPending: () => {} },
      ),
    ).rejects.toThrow(ReadOnlyViolation);
    await expect(ro.readiness()).rejects.toThrow(ReadOnlyViolation);
    expect(() => ro.readDid(BCM, '2E0A')).not.toThrow();
    expect(() => ro.readDid(BCM, 'ZZZZ')).toThrow(ReadOnlyViolation);
    await expect(ro.withReads?.(BCM, async (r) => r.readDid(BCM, '0A5E'))).resolves.toEqual({
      kind: 'ok',
      bytes: '3E00A00000',
    });
    expect(car.writes).toEqual([]);
    ro.release();
    ro.release();
    expect(released).toBe(1);
  });

  it('a full scan never asks the link to write, and holds the wire lock for the whole run', async () => {
    const car = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3E00A00000' } });
    let held = 0;
    (car as CarLink).lockReadOnly = () => {
      held += 1;
      return () => {
        held -= 1;
      };
    };
    const called: string[] = [];
    const deny = (name: string) => async () => {
      called.push(name);
      throw new Error(`${name} must never be called by a scan`);
    };
    car.writeDid = deny('writeDid');
    car.sequence = deny('sequence');
    car.readiness = deny('readiness');
    const reads: string[] = [];
    const real = car.readDid.bind(car);
    car.readDid = async (m, did): Promise<DidRead> => {
      expect(held).toBe(1);
      reads.push(did);
      return real(m, did);
    };
    let tick = 0;
    const deps: CodingDeps = {
      link: car,
      backups: new MemoryBackups(),
      signal: new AbortController().signal,
      now: () => new Date(Date.UTC(2026, 10, 3, 10, 0, 0) + tick++ * 100),
    };
    const events: CodingEvent[] = [];
    for await (const e of runSession(
      {
        kind: 'inspect',
        car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
        module: BCM,
        unit: 'all',
        label: 'Full car scan',
      },
      deps,
    ))
      events.push(e);
    expect(called).toEqual([]);
    expect(car.writes).toEqual([]);
    expect(held).toBe(0);
    expect(reads.length).toBeGreaterThan(300);
    expect(events.at(-1)).toMatchObject({ type: 'outcome', outcome: 'verified' });
  });

  it('the adapter policy refuses writes, routines, resets and security access while a scan holds it', () => {
    const policy = new SafetyPolicy();
    const state = { family: 'can11' as const, target: '70E' };
    const token = policy.issueCodingPermit('70E', { writes: ['2E0A5E3E00A00001'], securityAccess: true });
    const release = policy.enterReadOnly();
    for (const c of ['2E0A5E3E00A00001', '2703', '3101FF00', '1101', '14FFFFFF', '1002', '0100', '2F0A5E03'])
      expect(() => policy.check(c, state, undefined, token)).toThrow(/read-only scan/);
    for (const c of ['22F187', '3E00', '3E80', '1001', '1003', 'ATSH70E', 'ATSP0'])
      expect(() => policy.check(c, state)).not.toThrow();
    expect(() => policy.issueCodingPermit('70E', { writes: ['2E0A5E00'] })).toThrow(/read-only scan/);
    expect(() => policy.issueClearToken()).toThrow(/read-only scan/);
    release();
    expect(policy.readOnly).toBe(false);
    expect(() => policy.check('0100', state)).not.toThrow();
  });
});

describe('unit table and read plan', () => {
  it('lists every known address once, central electrics first, and shares one pair between alias units', () => {
    const units = scanUnits();
    expect(units[0]?.unit).toBe('09');
    const requests = units.map((u) => u.module.request);
    expect(new Set(requests).size).toBe(requests.length);
    expect(units.find((u) => u.module.request === '732')?.aliases).toContain('05');
    for (const u of ['17', '19', '5F', 'A5', '01']) expect(units.some((x) => x.unit === u)).toBe(true);
    expect(selectScanUnits(['9', '05']).map((u) => u.unit)).toEqual(['09', 'B7']);
  });

  it('reads identity, 0600, recipe identifiers, every lamp record and the manifest on the BCM', () => {
    const bcm = scanUnits().find((u) => u.unit === '09');
    if (!bcm) throw new Error('no BCM');
    const plan = readPlan(bcm);
    expect(plan.dids.slice(0, IDENTITY_DIDS.length)).toEqual([...IDENTITY_DIDS]);
    expect(plan.dids[IDENTITY_DIDS.length]).toBe('0600');
    for (const d of [...LAMP_DIDS, '0A5E', ...(APP_DATA.backupDids?.['09'] ?? [])])
      expect(plan.dids).toContain(d);
    expect(new Set(plan.dids).size).toBe(plan.dids.length);
    expect(plan.deep).toEqual([]);
    const deep = readPlan(bcm, { deep: true });
    expect(deep.deep.map((r) => `${r.from}-${r.to}`)).toEqual(['0400-0BFF', '5000-50FF', '6000-60FF']);
    expect(deep.deep[0]?.dids).not.toContain('0600');
  });
});

describe('lamp records (live Kushaq dump)', () => {
  it('decodes type, functions with names, and dims', () => {
    const front = decodeLampRecord('0550', KUSHAQ_LAMPS['0550'] as string);
    expect(front).toMatchObject({
      lamp: 'front turn signal, left',
      type: { code: 0x0c, name: 'Direction indicators/Turn signals' },
      defectBit: 0x34,
      faultByte: 0x14,
      empty: false,
      short: false,
    });
    expect(front.functions).toEqual([
      { slot: 'A', code: 0x02, name: 'Turn signal: left: bright phase', confirmed: true, reservedBit: false },
    ]);
    expect(front.dims).toEqual([{ pair: 'AB', level: 100, bit7: false }]);

    const side = decodeLampRecord('0552', KUSHAQ_LAMPS['0552'] as string);
    expect(side.functions.map((f) => `${f.slot}${f.code.toString(16)}`)).toEqual(['A14', 'C8', 'D9', 'E6']);
    expect(side.functions[0]?.name).toBe('Daytime running lights');
    expect(side.dims).toEqual([
      { pair: 'AB', level: 100, bit7: false },
      { pair: 'CD', level: 28, bit7: false },
      { pair: 'EF', level: 28, bit7: true },
    ]);

    const tail = decodeLampRecord('0567', KUSHAQ_LAMPS['0567'] as string);
    expect(tail.lamp).toBe('tail light, left');
    expect(tail.functions.map((f) => f.name)).toEqual([
      'Parking light in general (rear light, position light, boundary light)',
      'Parking light on the left (parking light activated on both sides left & right)',
    ]);
    expect(tail.dims[0]).toEqual({ pair: 'AB', level: 127, bit7: false });

    const hazardLed = decodeLampRecord('055B', KUSHAQ_LAMPS['055B'] as string);
    expect(hazardLed.functions[0]).toMatchObject({ code: 0x3e, confirmed: false });
    expect(decodeLampRecord('0560', '00'.repeat(16)).empty).toBe(true);
    expect(decodeLampRecord('0552', '0448004A1400').short).toBe(true);
    expect(lampName('0581')).toMatch(/PQ26/);
  });
});

describe('car map', () => {
  const bcm = (over: Partial<UnitReads> = {}) =>
    unitReads({
      unit: '09',
      module: BCM,
      answered: {
        F187: '32513039333730383944',
        '0600': '00'.repeat(30),
        '0A5E': '3E00A00000',
        ...KUSHAQ_LAMPS,
      },
      ...over,
    });

  it('decodes a feature from its bytes, says not fitted for absent units, and tables the lamps', () => {
    const map = buildCarMap(reads([bcm()]));
    expect(map.units[0]?.identity.part).toBe('2Q0937089D');
    const flashes = map.features.find((f) => f.recipeId === 'live-bcm-polite-blinks');
    expect(flashes?.state).toMatchObject({
      kind: 'set',
      choiceId: 'value-5',
      label: '5',
      did: '0A5E',
      unit: '09',
    });
    const cluster = map.features.find((f) => f.state.kind === 'not-fitted' && f.state.unit === '17');
    expect(cluster?.class).toBe('absent');
    expect(map.lamps.map((l) => l.did)).toEqual(Object.keys(KUSHAQ_LAMPS).sort());
    expect(map.totals).toMatchObject({ fitted: 1, values: 3 + Object.keys(KUSHAQ_LAMPS).length });
    expect(map.complete).toBe(true);
    expect(carMapMarkdown(map)).toMatch(/\| 0550 \| front turn signal, left \| 0C Direction indicators/);
    expect(carMapSummary(map)[0]).toMatch(/^1 of \d+ units answered: 09/);
  });

  it('keeps a truncated answer as far as it arrived, and never decodes a feature from it', () => {
    const map = buildCarMap(
      reads([bcm({ answered: { F187: '3251', '0600': '00'.repeat(30) }, truncated: { '0A5E': '3E' } })]),
    );
    expect(map.units[0]?.values['0A5E']).toEqual({ hex: '3E', length: 1, truncated: true });
    const flashes = map.features.find((f) => f.recipeId === 'live-bcm-polite-blinks');
    expect(flashes?.state).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/truncated/) });
    expect(map.totals.truncated).toBe(1);
  });

  it('settles a multi-part feature only when every part agrees', () => {
    const recipe = APP_DATA.recipes['el-drl-with-parking-lights'] as CodingRecipe;
    const steps = groupStepsOf(recipe);
    const on = Object.fromEntries(
      steps.map((s) => {
        const did = s.did as string;
        return [did, planGroupStep(s, 'enabled', KUSHAQ_LAMPS[did] as string, undefined).after.toUpperCase()];
      }),
    );
    const enabled = buildCarMap(reads([bcm({ answered: { ...bcm().answered, ...on } })]));
    expect(enabled.features.find((f) => f.recipeId === recipe.id)?.state).toMatchObject({
      kind: 'set',
      choiceId: 'enabled',
    });
    const firstDid = steps[0]?.did as string;
    const mixed = buildCarMap(
      reads([bcm({ answered: { ...bcm().answered, ...on, [firstDid]: KUSHAQ_LAMPS[firstDid] as string } })]),
    );
    const state = mixed.features.find((f) => f.recipeId === recipe.id)?.state;
    expect(state?.kind === 'set' && state.choiceId === 'enabled').toBe(false);
  });

  it('lists answering identifiers no recipe explains', () => {
    const map = buildCarMap(reads([bcm({ answered: { ...bcm().answered, '0E11': '01' } })]));
    expect(map.units[0]?.unknown).toContain('0E11');
    expect(map.units[0]?.unknown).not.toContain('0A5E');
    expect(map.units[0]?.unknown).not.toContain('0550');
  });
});
