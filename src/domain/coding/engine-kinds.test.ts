/**
 * The 2026-11 engine: every recipe shape runs end to end through the session — ops, alt (vendor variant
 * selection), scalar free values, multi-part groups — with read → durable backup → write → read-back → restore,
 * and the rerun rules that keep a run from ever replaying SecurityAccess or a marker.
 */
import { describe, expect, it } from 'vitest';
import { type SimOptions, SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { BackupStore, CodingEvent, CodingRecipe, CodingRequest, DidWrite } from './types.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};

class Memory implements BackupStore {
  records = new Map<string, BackupRecord>();
  async save(b: BackupRecord) {
    this.records.set(b.id, structuredClone(b));
  }
  async update(id: string, patch: Parameters<BackupStore['update']>[1]) {
    const cur = this.records.get(id);
    if (!cur) throw new Error('missing');
    this.records.set(id, { ...cur, ...patch });
  }
  async list() {
    return [...this.records.values()];
  }
}

const item = (recipe: CodingRecipe): FeatureItem => ({
  id: `feature-${recipe.id}`,
  name: recipe.name,
  tier: 'experimental',
  statusLabel: 'EXPERIMENTAL',
  recipeId: recipe.id,
  settings: [],
});

function setup(recipe: CodingRecipe, sim: SimOptions, extra: Partial<CodingDeps> = {}) {
  let ticks = 0;
  let ids = 0;
  const now = () => new Date(Date.UTC(2026, 10, 1, 12, 0, 0, ticks++));
  const car = new SimulatedCar({ now, sleep: async () => {}, ...sim });
  const backups = new Memory();
  const deps: CodingDeps = {
    link: car,
    backups,
    signal: new AbortController().signal,
    now,
    newId: () => `rec-${String(++ids).padStart(4, '0')}`,
    sleep: async () => {},
    readbackDelayMs: 0,
    moduleSnapshot: false,
    recipeFor: (id) => (id === recipe.id ? recipe : undefined),
    featureFor: () => item(recipe),
    ...extra,
  };
  return { car, backups, deps };
}

async function run(req: CodingRequest, deps: CodingDeps): Promise<CodingEvent[]> {
  const out: CodingEvent[] = [];
  for await (const e of runSession(req, deps)) out.push(e);
  return out;
}
const apply = (recipe: CodingRecipe, settingId: string): CodingRequest => ({
  kind: 'apply',
  car: CAR,
  feature: item(recipe),
  settingId,
});
const last = (events: CodingEvent[]) => events.at(-1);

// ---- ops ---------------------------------------------------------------------------------------------

const accWait: CodingRecipe = {
  id: 'csmqb-mqb-13-acc-wait-time',
  name: 'ACC wait time',
  kind: 'ops',
  unit: '13',
  requestId: '757',
  responseId: '7C1',
  password: '20103',
  did: '0600',
  choices: [
    { id: 'short', label: 'Short', ops: [{ byte: 11, bit: 0, len: 1, value: 1 }] },
    { id: 'long', label: 'Long', ops: [{ byte: 11, bit: 0, len: 1, value: 0 }] },
  ],
};

describe('ops recipes end to end', () => {
  it('writes the choice ops, backs up first with the union mask, and restores the original', async () => {
    const before = `${'00'.repeat(11)}F0${'00'.repeat(4)}`;
    const { car, backups, deps } = setup(accWait, {
      parts: { '757': '2Q0907572' },
      values: { '757:0600': before },
    });
    const events = await run(apply(accWait, 'short'), deps);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([
      expect.objectContaining({
        module: '757',
        did: '0600',
        bytes: `${'00'.repeat(11)}F1${'00'.repeat(4)}`,
        password: '20103',
      }),
    ]);
    const rec = backups.records.get('rec-0001') as BackupRecord;
    expect(rec).toMatchObject({ before, ownedMask: `${'00'.repeat(11)}01${'00'.repeat(4)}` });
    const undo = await run({ kind: 'restore', backup: rec }, deps);
    expect(last(undo)).toMatchObject({ outcome: 'verified' });
    expect(car.values.get('757:0600')).toBe(before);
    expect(backups.records.get('rec-0001')?.status).toBe('restored');
  });
});

// ---- alt: vendor selection ------------------------------------------------------------------------------

const alarm: CodingRecipe = {
  id: 'csmqb-alarm',
  name: 'Anti-theft alarm',
  kind: 'alt',
  unit: '09',
  requestId: '70E',
  responseId: '778',
  password: '31347',
  variants: [
    {
      selector: 'MQBAlternativeContainerForUnit09',
      requiresNewBcm: true,
      did: '0600',
      kind: 'field',
      field: { byteOffset: 1, bitOffset: 1, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'On', value: 1 },
        { id: 'disabled', label: 'Off', value: 0 },
      ],
    },
    {
      selector: 'MQBAlternativeContainerForUnit09',
      requiresNewBcm: false,
      did: '0600',
      kind: 'field',
      field: { byteOffset: 5, bitOffset: 0, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'On', value: 1 },
        { id: 'disabled', label: 'Off', value: 0 },
      ],
    },
  ],
};

describe('alt recipes: ordered first match from the module itself', () => {
  it('settles a same-DID unit-09 pair by the 0600 zero-run rule, records the variant and restores with it', async () => {
    const { car, backups, deps } = setup(alarm, {
      parts: { '70E': '2Q0937089D' },
      values: { '70E:0600': '4600C0000000' },
    });
    const events = await run(apply(alarm, 'enabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    // Old generation (not mostly zero): variant 1, byte 5 bit 0.
    expect(car.writes).toEqual([expect.objectContaining({ did: '0600', bytes: '4600C0000001' })]);
    const rec = backups.records.get('rec-0001') as BackupRecord;
    expect(rec.variant).toBe(1);
    expect(last(await run({ kind: 'restore', backup: rec }, deps))).toMatchObject({ outcome: 'verified' });
    expect(car.values.get('70E:0600')).toBe('4600C0000000');
  });

  it('picks the new generation when 0600 is (almost) all zero', async () => {
    const { car, deps } = setup(alarm, {
      parts: { '70E': '2Q0937089D' },
      values: { '70E:0600': '000000000001' },
    });
    expect(last(await run(apply(alarm, 'enabled'), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '000200000001' })]);
  });
});

// ---- scalar free value ------------------------------------------------------------------------------------

describe('scalar recipes: a free value end to end', () => {
  const idle: CodingRecipe = {
    id: 'csmqb-idle-rpm',
    name: 'Idle speed',
    kind: 'scalar',
    unit: '01',
    requestId: '7E0',
    responseId: '7E8',
    password: '27971',
    did: '0310',
    scalar: { byteOffset: 0, dataLength: 1, multiplier: 1, offset: -100 },
  };
  it('writes `value:<n>` and labels the backup with the number', async () => {
    const { car, backups, deps } = setup(idle, {
      parts: { '7E0': '04E906016' },
      values: { '7E0:0310': '64' },
    });
    expect(last(await run(apply(idle, 'value:20'), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '78' })]);
    expect(backups.records.get('rec-0001')).toMatchObject({ settingId: 'value:20', settingLabel: '20' });
  });
});

// ---- groups ---------------------------------------------------------------------------------------------

const wipers: CodingRecipe = {
  id: 'group:teardrop-wipers',
  name: 'Teardrop wipe',
  kind: 'group',
  unit: null,
  requestId: null,
  responseId: null,
  password: null,
  choices: [
    { id: 'enabled', label: 'On' },
    { id: 'disabled', label: 'Off' },
  ],
  steps: [
    {
      id: 'teardrop-p1',
      name: 'Teardrop part 1',
      kind: 'field',
      unit: '09',
      requestId: '70E',
      responseId: '778',
      password: '31347',
      did: '0A72',
      field: { byteOffset: 1, bitOffset: 2, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'On', value: 1 },
        { id: 'disabled', label: 'Off', value: 0 },
      ],
    },
    {
      id: 'teardrop-p2',
      name: 'Teardrop part 2',
      kind: 'ops',
      unit: '17',
      requestId: '714',
      responseId: '77E',
      password: '47115',
      did: '6001',
      choices: [{ id: 'apply', label: 'Apply', ops: [{ byte: 2, bit: 5, len: 1, value: 1 }] }],
    },
  ],
};
const groupSim: SimOptions = {
  parts: { '70E': '2Q0937089D', '714': '6JM920310' },
  values: { '70E:0A72': '0000', '714:6001': '000000' },
};

describe('group recipes: plan every part, one record, write in order, restore in reverse', () => {
  it('writes each part on its own module with one durable record holding every part', async () => {
    const { car, backups, deps } = setup(wipers, groupSim);
    const events = await run(apply(wipers, 'enabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes.map((w) => [w.module, w.did, w.bytes, w.password])).toEqual([
      ['70E', '0A72', '0004', '31347'],
      ['714', '6001', '000020', '47115'],
    ]);
    expect(events.filter((e) => e.type === 'group-step')).toHaveLength(2);
    expect(backups.records.size).toBe(1);
    const rec = backups.records.get('rec-0001') as BackupRecord;
    expect(rec).toMatchObject({ groupId: wipers.id, stepIndex: 0, status: 'verified', did: '0A72' });
    expect(
      rec.steps?.map((s) => [s.index, s.module.request, s.did, s.before, s.intended, s.ownedMask, s.status]),
    ).toEqual([
      [0, '70E', '0A72', '0000', '0004', '0004', 'verified'],
      [1, '714', '6001', '000000', '000020', '000020', 'verified'],
    ]);
  });

  it('carries the full VIN from the car check into the one record', async () => {
    const { backups, deps } = setup(wipers, groupSim);
    const events = await run(apply(wipers, 'enabled'), deps);
    expect(events.find((e) => e.type === 'car-verified')).toMatchObject({ vin: 'MEXSIM00000000001' });
    expect((backups.records.get('rec-0001') as BackupRecord).vin.full).toBe('MEXSIM00000000001');
  });

  it('restores the parts in reverse order from that one record', async () => {
    const { car, backups, deps } = setup(wipers, groupSim);
    await run(apply(wipers, 'enabled'), deps);
    car.writes.length = 0;
    const rec = backups.records.get('rec-0001') as BackupRecord;
    const events = await run({ kind: 'restore', backup: rec }, deps);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes.map((w) => [w.module, w.bytes])).toEqual([
      ['714', '000000'],
      ['70E', '0000'],
    ]);
    expect(backups.records.get('rec-0001')?.status).toBe('restored');
    expect(backups.records.get('rec-0002')).toMatchObject({
      operation: 'restore',
      restoreOf: 'rec-0001',
      groupId: wipers.id,
    });
  });

  it('parts that share a DID build on each other: the later part never writes back the earlier part', async () => {
    const bit = (id: string, bitOffset: number): CodingRecipe => ({
      id,
      name: id,
      kind: 'field',
      unit: '09',
      requestId: '70E',
      responseId: '778',
      password: '31347',
      did: '0A5E',
      field: { byteOffset: 2, bitOffset, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'On', value: 1 },
        { id: 'disabled', label: 'Off', value: 0 },
      ],
    });
    const shared: CodingRecipe = {
      id: 'group:shared-did',
      name: 'Shared DID',
      kind: 'group',
      unit: null,
      requestId: null,
      responseId: null,
      password: null,
      choices: [
        { id: 'enabled', label: 'On' },
        { id: 'disabled', label: 'Off' },
      ],
      steps: [bit('shared-p1', 1), bit('shared-p2', 6)],
    };
    const { car, backups, deps } = setup(shared, {
      parts: { '70E': '2Q0937089D' },
      values: { '70E:0A5E': '000000' },
    });
    expect(last(await run(apply(shared, 'enabled'), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes.map((w) => w.bytes)).toEqual(['000002', '000042']);
    expect(car.values.get('70E:0A5E')).toBe('000042');
    const rec = backups.records.get('rec-0001') as BackupRecord;
    expect(rec.steps?.map((s) => [s.before, s.intended])).toEqual([
      ['000000', '000002'],
      ['000002', '000042'],
    ]);
    // "Check again" judges each part on its own bits: the earlier part's intended bytes predate the later
    // part, which is not a mismatch.
    expect(last(await run({ kind: 'recheck', backup: rec }, deps))).toMatchObject({
      outcome: 'observed-match',
    });
    car.values.set('70E:0A5E', '000040');
    expect(last(await run({ kind: 'recheck', backup: rec }, deps))).toMatchObject({ outcome: 'mismatch' });
    car.values.set('70E:0A5E', '000042');
    const checked = backups.records.get('rec-0001') as BackupRecord;
    car.writes.length = 0;
    expect(last(await run({ kind: 'restore', backup: checked }, deps))).toMatchObject({
      outcome: 'verified',
    });
    expect(car.writes.map((w) => w.bytes)).toEqual(['000002', '000000']);
    expect(car.values.get('70E:0A5E')).toBe('000000');
    const restore = [...backups.records.values()].find((b) => b.operation === 'restore') as BackupRecord;
    expect(last(await run({ kind: 'recheck', backup: restore }, deps))).toMatchObject({
      outcome: 'observed-match',
    });
  });

  it('a part whose control-unit version does not match is skipped (written back unchanged), not refused', async () => {
    const plain: CodingRecipe = {
      id: 'plain-part',
      name: 'plain',
      kind: 'field',
      unit: '09',
      requestId: '70E',
      responseId: '778',
      password: '31347',
      did: '0A5E',
      field: { byteOffset: 0, bitOffset: 0, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'On', value: 1 },
        { id: 'disabled', label: 'Off', value: 0 },
      ],
    };
    const cameraOnly: CodingRecipe = {
      id: 'camera-part',
      name: 'camera',
      kind: 'alt',
      unit: 'A5',
      requestId: '74F',
      responseId: '7B9',
      password: '20103',
      did: '09A3',
      variants: [
        {
          selector: 'device',
          devicePattern: '*3Q*980654*',
          did: '09A3',
          kind: 'field',
          field: { byteOffset: 0, bitOffset: 6, bitLength: 1, byteOrder: 'big' },
          choices: [
            { id: 'enabled', label: 'On', value: 1 },
            { id: 'disabled', label: 'Off', value: 0 },
          ],
        },
      ],
    };
    const grp: CodingRecipe = {
      id: 'group:camera-skip',
      name: 'camera skip',
      kind: 'group',
      unit: null,
      requestId: null,
      responseId: null,
      password: null,
      choices: [
        { id: 'enabled', label: 'On' },
        { id: 'disabled', label: 'Off' },
      ],
      steps: [plain, cameraOnly],
    };
    const { car, deps } = setup(grp, {
      parts: { '70E': '2Q0937089D', '74F': '2Q0980654E' },
      values: { '70E:0A5E': '00', '74F:09A3': '00' },
    });
    const events = await run(apply(grp, 'enabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    expect(
      events.some(
        (e) =>
          e.type === 'warning' &&
          /Part of this change didn't apply to your car/.test(e.detail) &&
          /Part 2 of 2/.test(e.technical ?? ''),
      ),
    ).toBe(true);
    expect(car.writes.map((w) => [w.module, w.did])).toEqual([['70E', '0A5E']]);
  });

  it('"off" applies the per-part choice and puts a single-choice part back from the earlier change', async () => {
    const { car, deps } = setup(wipers, groupSim);
    car.values.set('714:6001', '010000');
    await run(apply(wipers, 'enabled'), deps);
    expect(car.values.get('714:6001')).toBe('010020');
    car.writes.length = 0;
    const events = await run(apply(wipers, 'disabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes.map((w) => [w.module, w.bytes])).toEqual([
      ['70E', '0000'],
      ['714', '010000'],
    ]);
  });

  it('plans every part before writing: an unreadable later part means nothing is written or saved', async () => {
    const { car, backups, deps } = setup(wipers, { ...groupSim, values: { '70E:0A72': '0000' } });
    const events = await run(apply(wipers, 'enabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'not-sent' });
    expect(car.writes).toHaveLength(0);
    expect(backups.records.size).toBe(0);
  });

  it('a part that fails after another landed is pending-uncertain, with the landed part recorded and restorable', async () => {
    const { car, backups, deps } = setup(wipers, groupSim);
    const real = car.writeDid.bind(car);
    car.writeDid = async (module, did, bytes, options): Promise<DidWrite> =>
      module.request === '714' ? { kind: 'nrc', code: '22' } : real(module, did, bytes, options);
    const events = await run(apply(wipers, 'enabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'pending-uncertain' });
    expect(last(events)).toMatchObject({
      phase: expect.stringMatching(/Part 2 of 2 stopped.*1 part before it was changed/),
    });
    const rec = backups.records.get('rec-0001') as BackupRecord;
    expect(rec.status).toBe('unconfirmed');
    expect(rec.steps?.map((s) => s.status)).toEqual(['verified', 'refused']);
    car.writeDid = real;
    car.writes.length = 0;
    expect(last(await run({ kind: 'restore', backup: rec }, deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes.map((w) => [w.module, w.bytes])).toEqual([['70E', '0000']]);
  });

  it('a first part the module refuses is a clean rejection: nothing landed', async () => {
    const { car, backups, deps } = setup(wipers, { ...groupSim, write: { kind: 'nrc', code: '31' } });
    const events = await run(apply(wipers, 'enabled'), deps);
    expect(last(events)).toMatchObject({ outcome: 'rejected' });
    expect(backups.records.get('rec-0001')?.steps?.map((s) => s.status)).toEqual(['refused', 'planned']);
    expect(car.values.get('714:6001')).toBe('000000');
  });

  it('rechecks every landed part', async () => {
    const { car, backups, deps } = setup(wipers, groupSim);
    await run(apply(wipers, 'enabled'), deps);
    const rec = backups.records.get('rec-0001') as BackupRecord;
    expect(last(await run({ kind: 'recheck', backup: rec }, deps))).toMatchObject({
      outcome: 'observed-match',
    });
    car.values.set('714:6001', '000000');
    expect(last(await run({ kind: 'recheck', backup: rec }, deps))).toMatchObject({ outcome: 'mismatch' });
  });
});

// ---- rerun rules -------------------------------------------------------------------------------------------

describe('reruns never replay SecurityAccess, a marker, or anything after an acknowledgement', () => {
  const blinks: CodingRecipe = {
    id: 'blinks',
    name: 'Blinks',
    kind: 'field',
    unit: '09',
    requestId: '70E',
    responseId: '778',
    password: '31347',
    did: '0A5E',
    field: { byteOffset: 0, bitOffset: 1, bitLength: 2, byteOrder: 'big' },
    choices: [
      { id: 'value-3', label: '3', value: 1 },
      { id: 'value-5', label: '5', value: 3 },
    ],
  };
  const sim: SimOptions = { parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3A00000000' } };
  const noRelink = async () => {
    throw new Error('relink must not be called');
  };

  it('a run that sent SecurityAccess and then stopped before the payload is not re-run', async () => {
    const { car, deps } = setup(blinks, sim, { relink: noRelink });
    car.writeDid = async (_m, _d, _b, options): Promise<DidWrite> => {
      options.onTxFrame?.(0, { can: '70E', data: '0227030000000000', stage: 'submitted' });
      return { kind: 'not-sent', detail: 'The key got no answer.' };
    };
    const events = await run(apply(blinks, 'value-5'), deps);
    expect(events.some((e) => e.type === 'security-access')).toBe(true);
    expect(events.some((e) => e.type === 'relink')).toBe(false);
    expect(last(events)).toMatchObject({ outcome: 'not-sent' });
  });

  it('a run that sent a coding marker is not re-run, whatever the marker answered', async () => {
    const { deps } = setup(
      blinks,
      {
        ...sim,
        write: { kind: 'not-sent', detail: 'Marker silent.' },
        markers: [{ did: 'F199', outcome: 'no-answer' }],
      },
      { relink: noRelink },
    );
    const events = await run(apply(blinks, 'value-5'), deps);
    expect(events.some((e) => e.type === 'relink')).toBe(false);
    expect(last(events)).toMatchObject({ outcome: 'not-sent' });
  });

  it('an acknowledged write that lost the link is never re-run', async () => {
    const { car, deps } = setup(blinks, sim, { relink: noRelink });
    car.writeDid = async () => ({ kind: 'acked', incomplete: { step: '1101', reason: 'link-lost' } });
    const events = await run(apply(blinks, 'value-5'), deps);
    expect(events.some((e) => e.type === 'relink')).toBe(false);
    expect(last(events)).toMatchObject({ outcome: 'pending-uncertain' });
  });

  it('a silent module before anything mutating left IS re-run on a fresh adapter', async () => {
    const { car, deps } = setup(blinks, sim);
    car.writeDid = async () => ({ kind: 'not-sent', detail: 'Session silent.' });
    const fresh = new SimulatedCar({ ...sim, sleep: async () => {} });
    const events = await run(apply(blinks, 'value-5'), { ...deps, relink: async () => fresh });
    expect(events.filter((e) => e.type === 'relink')).toHaveLength(1);
    expect(last(events)).toMatchObject({ outcome: 'verified' });
    expect(fresh.writes).toHaveLength(1);
  });
});

describe('security codes', () => {
  it('names a refused unit-default code plainly', async () => {
    const r: CodingRecipe = {
      id: 'hvac',
      name: 'HVAC',
      kind: 'field',
      unit: '08',
      requestId: '746',
      responseId: '7B0',
      password: '20103',
      passwordSource: 'unit-default',
      did: '0600',
      field: { byteOffset: 0, bitOffset: 6, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'On', value: 1 },
        { id: 'disabled', label: 'Off', value: 0 },
      ],
    };
    const { deps } = setup(r, {
      parts: { '746': '6JM907057A' },
      values: { '746:0600': '00' },
      write: { kind: 'nrc', code: '33' },
    });
    const events = await run(apply(r, 'enabled'), deps);
    const refused = events.find((e) => e.type === 'refused');
    expect(refused).toMatchObject({
      reason: 'ecu-refused',
      code: '33',
      detail: expect.stringContaining('needs a different access code'),
    });
    // The access code itself is never put in any message.
    expect(JSON.stringify(events.filter((e) => e.type === 'refused' || e.type === 'outcome'))).not.toContain(
      '20103',
    );
  });
});
