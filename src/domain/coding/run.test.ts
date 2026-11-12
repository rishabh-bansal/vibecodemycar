import { describe, expect, it } from 'vitest';
import { type SimOptions, SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { findFeature } from '../catalog/features.ts';
import type { Recipe } from '../catalog/schema.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { journalItem } from '../logs/redact.ts';
import { fingerprintVin } from '../vin.ts';
import { recipeDigest } from './plan.ts';
import { type CodingDeps, isQuarantined, runSession } from './run.ts';
import type { BackupStore, CarLink, CodingEvent, CodingRecipe, CodingRequest } from './types.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const SIM_VIN = 'MEXSIM00000000001';
const PART = '2Q0937089D';
const KEY = '70E:0A5E';

function feature(): FeatureItem {
  const f = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
  if (f?.tier !== 'tested') throw new Error('fixture feature should be tested for this car');
  return f;
}
/** A trusted catalogue that offers the fixture feature with these settings (for synthetic recipes). */
const offering =
  (...ids: string[]): CodingDeps['featureFor'] =>
  () => ({ ...feature(), settings: ids.map((id, value) => ({ id, label: id, value })) });
const apply = (settingId = 'value-5'): CodingRequest => ({
  kind: 'apply',
  car: CAR,
  feature: feature(),
  settingId,
});

class MemoryBackups implements BackupStore {
  records = new Map<string, BackupRecord>();
  failSave = false;
  /** Backup state at the moment each write reached the wire — proves "durable before write". */
  async save(b: BackupRecord) {
    if (this.failSave) throw new Error('disk full');
    this.records.set(b.id, structuredClone(b));
  }
  async update(id: string, patch: Parameters<BackupStore['update']>[1]) {
    const cur = this.records.get(id);
    if (cur) this.records.set(id, { ...cur, ...patch });
  }
}

function setup(sim: SimOptions = {}, deps: Partial<CodingDeps> = {}) {
  let ticks = 0;
  const now = deps.now ?? (() => new Date(Date.UTC(2026, 9, 24, 12, 0, ticks++)));
  const car = new SimulatedCar({ parts: { '70E': PART }, values: { [KEY]: '3A00000000' }, now, ...sim });
  const backups = new MemoryBackups();
  const controller = new AbortController();
  const full: CodingDeps = {
    link: car,
    backups,
    signal: controller.signal,
    now,
    newId: () => 'backup-0001',
    sleep: async () => {},
    readbackDelayMs: 0,
    ...deps,
  };
  return { car, backups, controller, deps: full };
}

async function run(req: CodingRequest, deps: CodingDeps): Promise<CodingEvent[]> {
  const out: CodingEvent[] = [];
  for await (const e of runSession(req, deps)) out.push(e);
  return out;
}
const types = (events: CodingEvent[]) => events.map((e) => e.type);
const outcome = (events: CodingEvent[]) => events.find((e) => e.type === 'outcome');

describe('runCoding — apply, the happy path', () => {
  it('verifies, backs up BEFORE writing, writes once, and reads back exactly', async () => {
    const { car, backups, deps } = setup();
    const events = await run(apply(), deps);

    expect(types(events)).toEqual([
      'verify-started',
      'car-verified',
      'readiness',
      'backup-saved',
      'request-sent',
      'write-acked',
      'check-started',
      'readback',
      'outcome',
    ]);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([{ module: '70E', did: '0A5E', bytes: '3E00000000', password: '31347' }]);
    expect(car.values.get(KEY)).toBe('3E00000000');

    const record = backups.records.get('backup-0001');
    expect(record).toMatchObject({
      before: '3A00000000',
      intended: '3E00000000',
      status: 'verified',
      observed: '3E00000000',
    });
    expect(record?.vin.masked).toBe('MEXS…0001');
    expect(record?.vin.full).toBe(SIM_VIN);
  });

  it('carries the full VIN from the car check through the journal into its log item', async () => {
    const { backups, deps } = setup();
    const events = await run(apply(), deps);
    expect(events.find((e) => e.type === 'car-verified')).toMatchObject({
      vin: SIM_VIN,
      vinMasked: 'MEXS…0001',
    });
    const record = backups.records.get('backup-0001');
    if (!record) throw new Error('expected a journal');
    expect(record.vin).toEqual({
      masked: 'MEXS…0001',
      fingerprint: await fingerprintVin(SIM_VIN),
      full: SIM_VIN,
    });
    const item = journalItem(record);
    expect(item.vin).toBe(SIM_VIN);
    expect((item.body.vin as BackupRecord['vin']).full).toBe(SIM_VIN);
  });

  it('has the backup durable before the request leaves', async () => {
    const { car, backups, deps } = setup();
    const seen: number[] = [];
    const original = car.writeDid.bind(car);
    car.writeDid = async (...args) => {
      seen.push(backups.records.size);
      return original(...args);
    };
    await run(apply(), deps);
    expect(seen).toEqual([1]);
  });
});

describe('runCoding — success only ever comes from an exact read-back', () => {
  it('reports observed-match (not verified) when the car never sent a final answer but the value landed', async () => {
    const { car, deps } = setup({ write: { kind: 'silent-applies' } });
    const events = await run(apply(), deps);
    expect(types(events)).toContain('response-pending');
    expect(types(events)).not.toContain('write-acked');
    expect(outcome(events)).toMatchObject({ outcome: 'observed-match' });
    expect(car.writes).toHaveLength(1);
  });

  // Owner decision D3 (docs/reviews/2026-10-25/FIXES.md): the BCM sets 0A5E byte 2 = A0 itself when
  // polite blinks is enabled. Byte 2 holds none of the recipe's bits, so that is the module's own state.
  it('succeeds when the module changes a byte the recipe does not touch, and records it (the 3E00A00000 case)', async () => {
    const { backups, deps } = setup({ write: { kind: 'ack-stores', bytes: '3E00A00000' } });
    const events = await run(apply(), deps);
    const managed = [{ offset: 2, wrote: '00', stored: 'A0' }];
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(events.find((e) => e.type === 'readback')).toMatchObject({
      matches: true,
      moduleManaged: managed,
    });
    expect(backups.records.get('backup-0001')).toMatchObject({
      status: 'verified',
      observed: '3E00A00000',
      ownedMask: '1600000000',
      moduleManaged: managed,
    });
    // Plain words on screen; the exact bytes stay in the readback event and the journal (above).
    expect(outcome(events)).toMatchObject({ phase: expect.stringContaining('also changed something') });
    expect(outcome(events)).not.toMatchObject({ phase: expect.stringMatching(/byte|A0/) });
    expect(outcome(events)).not.toMatchObject({ phase: expect.stringContaining('manages itself') });
  });

  it.each([
    ['empty', ''],
    ['truncated', '3E'],
    ['longer than written', '3E0000000000'],
    ['target unchanged', '3A00000000'],
    ['unrelated value', 'DEADBEEF00'],
    ['a different blink count', '3C00000000'],
    ['an unowned bit changed in a byte the recipe writes into', '3F00000000'],
  ])('is a mismatch for a %s read-back', async (_name, stored) => {
    const { deps } = setup({ write: { kind: 'ack-stores', bytes: stored } });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'mismatch' });
  });

  it('is uncertain, not failed, when the write went unanswered and the value never changed', async () => {
    const { car, deps } = setup({ write: { kind: 'silent-drops' } });
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'mismatch' });
    expect(car.writes).toHaveLength(1);
  });

  it('is uncertain when the value cannot be read back at all', async () => {
    const { deps } = setup({ write: { kind: 'silent-applies' }, read: 'unreadable-after-write' });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'pending-uncertain' });
  });

  it('retries only the READ when the first read-back is stale, and still never re-sends', async () => {
    const { car, deps } = setup({ read: 'stale-once' });
    const events = await run(apply(), deps);
    const reads = events.filter((e) => e.type === 'readback');
    expect(reads).toHaveLength(2);
    expect(reads.map((e) => e.type === 'readback' && e.matches)).toEqual([false, true]);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
  });

  it('names the record after the trusted catalogue entry, not the request', async () => {
    const { backups, deps } = setup();
    const spoofed = {
      ...feature(),
      name: 'Something else',
      settings: feature().settings.map((s) => ({ ...s, label: 'x' })),
    };
    await run({ kind: 'apply', car: CAR, feature: spoofed, settingId: 'value-5' }, deps);
    expect(backups.records.get('backup-0001')).toMatchObject({
      featureName: feature().name,
      settingLabel: '5 blinks',
    });
  });

  it('bounds read-back attempts', async () => {
    const { deps } = setup({ write: { kind: 'ack-stores', bytes: '3C00000000' } }, { readbackAttempts: 2 });
    const events = await run(apply(), deps);
    expect(events.filter((e) => e.type === 'readback')).toHaveLength(2);
  });
});

describe('runCoding — coding markers written while preparing', () => {
  const F199_STORED = [
    { did: 'F199', outcome: 'acked' },
    { did: 'F198', outcome: 'refused' },
  ] as const;

  it('never says "nothing changed" when a marker was stored before the sequence stopped', async () => {
    const { car, backups, deps } = setup({
      write: { kind: 'not-sent', detail: 'The control unit refused the sequence marker (code 13).' },
      markers: [...F199_STORED],
    });
    const events = await run(apply(), deps);
    expect(car.writes).toHaveLength(0);
    expect(events.find((e) => e.type === 'markers')).toMatchObject({ markers: F199_STORED });
    expect(events.find((e) => e.type === 'refused')).toMatchObject({
      reason: 'ecu-refused',
      detail: expect.stringContaining('Your car did note the date of this change attempt'),
    });
    expect(outcome(events)).toMatchObject({
      outcome: 'not-sent',
      phase: expect.not.stringContaining('Nothing was changed'),
    });
    expect(backups.records.get('backup-0001')).toMatchObject({
      status: 'refused',
      outcome: 'not-sent',
      markers: F199_STORED,
    });
  });

  it('records the markers of a successful write with the verified result', async () => {
    const markers = [
      { did: 'F199', outcome: 'acked' },
      { did: 'F198', outcome: 'acked' },
    ] as const;
    const { backups, deps } = setup({ markers: [...markers] });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'verified' });
    expect(backups.records.get('backup-0001')).toMatchObject({ status: 'verified', markers });
  });

  it('says a marker MAY have been stored when its write got no answer', async () => {
    const { deps } = setup({
      write: { kind: 'not-sent', detail: 'The date marker write got no clear answer.' },
      markers: [{ did: 'F199', outcome: 'no-answer' }],
    });
    const refusal = (await run(apply(), deps)).find((e) => e.type === 'refused');
    expect(refusal).toMatchObject({
      detail: expect.stringContaining('Your car may have noted the date of this change attempt'),
    });
    expect(refusal).not.toMatchObject({ detail: expect.stringContaining('F199') });
  });

  it('reports readiness that expired during preparation as not-ready, not as a refusal by the car', async () => {
    const { deps } = setup({
      write: {
        kind: 'not-sent',
        reason: 'not-ready',
        detail: 'The car check expired before the change was sent.',
      },
    });
    expect((await run(apply(), deps)).find((e) => e.type === 'refused')).toMatchObject({
      reason: 'not-ready',
    });
  });
});

describe('runCoding — failures after the request left', () => {
  it('treats a negative response as a definite refusal, with the backup marked refused', async () => {
    const { backups, deps } = setup({ write: { kind: 'nrc', code: '88' } });
    const events = await run(apply(), deps);
    expect(events.find((e) => e.type === 'refused')).toMatchObject({ reason: 'ecu-refused' });
    expect(outcome(events)).toMatchObject({ outcome: 'rejected' });
    expect(backups.records.get('backup-0001')?.status).toBe('refused');
  });

  it('treats a link that dies after sending as uncertain, never failure, and does not retry', async () => {
    const { car, backups, deps } = setup({ write: { kind: 'link-lost', applied: true } });
    const events = await run(apply(), deps);
    expect(types(events)).toContain('link-lost');
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
    expect(car.writes).toHaveLength(1);
    expect(backups.records.get('backup-0001')?.status).toBe('unconfirmed');
  });

  it('treats a throwing link the same way', async () => {
    const { car, deps } = setup();
    car.writeDid = async () => {
      throw new Error('GATT error');
    };
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
  });

  it('keeps a marker the link reported before it wedged, even though the write never returns', async () => {
    const { car, backups, deps } = setup({}, { writeDeadlineMs: 20 });
    car.writeDid = (_m, _d, _b, options) => {
      options.onMarker?.({ did: 'F199', outcome: 'no-answer' });
      return new Promise(() => {});
    };
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({
      outcome: 'pending-uncertain',
      phase: expect.stringContaining('Your car may have noted the date of this change attempt'),
    });
    expect(backups.records.get('backup-0001')).toMatchObject({
      markers: [{ did: 'F199', outcome: 'no-answer' }],
    });
  });

  it('keeps the frames a wedged or throwing write reported, with their address and stage (C3.8)', async () => {
    const wedged = setup({}, { writeDeadlineMs: 20 });
    wedged.car.writeDid = (_m, _d, _b, options) => {
      options.onTxFrame?.(0, { can: '70E', data: '10082E0A5E3E0000', stage: 'submitted' });
      options.onTxFrame?.(1, { can: '70E', data: '2100000000000000', stage: 'attempted' });
      return new Promise(() => {});
    };
    await run(apply(), wedged.deps);
    expect(wedged.backups.records.get('backup-0001')?.txFrames).toEqual([
      { can: '70E', data: '10082E0A5E3E0000', stage: 'submitted', at: expect.any(String) },
      { can: '70E', data: '2100000000000000', stage: 'attempted', at: expect.any(String) },
    ]);

    const throwing = setup();
    throwing.car.writeDid = async (_m, _d, _b, options) => {
      options.onTxFrame?.(0, { can: '70E', data: '062E0A5E3E000000', stage: 'attempted' });
      options.onTxFrame?.(0, { can: '70E', data: '062E0A5E3E000000', stage: 'failed' });
      throw new Error('GATT error');
    };
    await run(apply(), throwing.deps);
    expect(throwing.backups.records.get('backup-0001')?.txFrames).toEqual([
      { can: '70E', data: '062E0A5E3E000000', stage: 'failed', at: expect.any(String) },
    ]);
  });

  it('journals at most the capacity, keeping the last frame and counting what it left out (C3.4)', async () => {
    const { car, backups, deps } = setup();
    car.writeDid = async (_m, _d, _b, options) => {
      for (let n = 0; n < 1100; n++)
        options.onTxFrame?.(n, {
          can: '70E',
          data: n.toString(16).padStart(4, '0').toUpperCase(),
          stage: 'submitted',
        });
      return { kind: 'no-reply' };
    };
    await run(apply(), deps);
    const record = backups.records.get('backup-0001');
    expect(record?.txFrames).toHaveLength(1024);
    expect(record?.txFramesOmitted).toBe(76);
    expect(record?.txFrames?.at(-1)).toMatchObject({ data: '044B' });
  });

  it('gives up on a wedged write at the hard deadline instead of hanging', async () => {
    const { car, deps } = setup({}, { writeDeadlineMs: 20 });
    car.writeDid = () => new Promise(() => {});
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
    // The link never reported the send, so the history does not claim it.
    expect(types(events)).not.toContain('request-sent');
  });

  it('treats a read-back that throws as a lost link: retired, recorded uncertain, never left "prepared"', async () => {
    const { car, backups, deps } = setup();
    car.readDid = async (module, did) => {
      if (car.writes.length) throw new Error('GATT error');
      return SimulatedCar.prototype.readDid.call(car, module, did);
    };
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
    expect(isQuarantined(car)).toBe(true);
    expect(backups.records.get('backup-0001')).toMatchObject({
      status: 'unconfirmed',
      outcome: 'pending-uncertain',
    });
  });

  it('is uncertain, not a mismatch, when the link drops after a stale first read-back', async () => {
    const { car, backups, deps } = setup();
    let checks = 0;
    car.readDid = async (module, did) => {
      if (!car.writes.length) return SimulatedCar.prototype.readDid.call(car, module, did);
      checks++;
      return checks === 1 ? { kind: 'ok', bytes: '3A00000000' } : { kind: 'link-lost' };
    };
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
    expect(backups.records.get('backup-0001')).toMatchObject({
      outcome: 'pending-uncertain',
      observed: '3A00000000',
    });
  });

  it('plans from lower-case bytes a link may report', async () => {
    const { car, deps } = setup({ values: { [KEY]: '3a00000000' } });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '3E00000000' })]);
  });
});

describe('runCoding — refusals before anything is sent', () => {
  const expectNothingSent = (car: SimulatedCar, backups: MemoryBackups) => {
    expect(car.writes).toHaveLength(0);
    expect(backups.records.size).toBe(0);
  };

  it('codes a different car than the paired one, with a warning; the backup records the car written', async () => {
    const { car, backups, deps } = setup(
      {},
      { expectedVinFingerprint: await fingerprintVin('MEXOTHER000000009') },
    );
    const events = await run(apply(), deps);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({ code: 'other-car' });
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
    expect(backups.records.get('backup-0001')?.vin.fingerprint).toBe(await fingerprintVin(SIM_VIN));
  });

  it('names the connected car by its full VIN in the other-car warning', async () => {
    const { deps } = setup({}, { expectedVinFingerprint: await fingerprintVin('MEXOTHER000000009') });
    const events = await run(apply(), deps);
    const warning = events.find((e) => e.type === 'warning' && e.code === 'other-car');
    expect(warning && 'detail' in warning ? warning.detail : '').toContain(SIM_VIN);
  });

  it('keeps the technical detail of a warning in the backup record', async () => {
    const { backups, deps } = setup({ parts: {} });
    const events = await run(apply(), deps);
    const warning = events.find((e) => e.type === 'warning' && e.code === 'identity');
    if (warning?.type !== 'warning' || !warning.technical) throw new Error('expected an identity warning');
    const stored = backups.records.get('backup-0001')?.warnings ?? [];
    expect(stored).toContain(`${warning.detail} (${warning.technical})`.slice(0, 400));
  });

  it('accepts the paired car', async () => {
    const { deps } = setup({}, { expectedVinFingerprint: await fingerprintVin(SIM_VIN) });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'verified' });
  });

  it('codes a control unit version nobody has proven, and journals its part (no part binding)', async () => {
    const { car, backups, deps } = setup({ parts: { '70E': '2Q0937089X' } });
    const events = await run(apply(), deps);
    expect(events.find((e) => e.type === 'refused')).toBeUndefined();
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
    expect(backups.records.get('backup-0001')?.module.part).toBe('2Q0937089X');
  });

  it('refuses when the car reports no VIN', async () => {
    const { car, backups, deps } = setup({ vin: null });
    expect(events_reason(await run(apply(), deps))).toBe('no-vin');
    expectNothingSent(car, backups);
  });

  it('codes a control unit that will not identify itself, recording its part as unknown', async () => {
    const { car, backups, deps } = setup({ parts: {} });
    const events = await run(apply(), deps);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({ code: 'identity' });
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
    expect(backups.records.get('backup-0001')?.module.part).toBe('unknown');
  });

  it('refuses when the setting cannot be read (nothing to back up)', async () => {
    const { car, backups, deps } = setup({ values: {} });
    expect(events_reason(await run(apply(), deps))).toBe('ecu-refused');
    expectNothingSent(car, backups);
  });

  it('overwrites a current value the recipe does not declare (only the field bits change)', async () => {
    // A 2-bit field that declares only values 0 and 1; the car holds 3.
    const narrow: CodingRecipe = {
      id: 'synthetic-narrow',
      name: 'narrow',
      kind: 'field',
      requestId: '70E',
      responseId: '778',
      did: '0A5E',
      field: { byteOffset: 0, bitOffset: 1, bitLength: 2, byteOrder: 'big' },
      choices: [
        { id: 'low', label: 'Low', value: 0 },
        { id: 'high', label: 'High', value: 1 },
      ],
    };
    const { car, backups, deps } = setup(
      { values: { [KEY]: '0600000000' } },
      { recipeFor: () => narrow, featureFor: offering('low', 'high') },
    );
    expect(outcome(await run(apply('high'), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '0200000000' })]);
    expect(backups.records.get('backup-0001')).toMatchObject({
      before: '0600000000',
      intended: '0200000000',
    });
  });

  it('says so, and sends nothing, when the car already holds the value', async () => {
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00000000' } });
    expect(events_reason(await run(apply(), deps))).toBe('already-set');
    expectNothingSent(car, backups);
  });

  it('does not write if the backup cannot be saved', async () => {
    const { car, backups, deps } = setup();
    backups.failSave = true;
    expect(events_reason(await run(apply(), deps))).toBe('backup-failed');
    expectNothingSent(car, backups);
  });

  it("journals the writer's decisions as events, before the send they led to", async () => {
    const { car, deps } = setup();
    const write = car.writeDid.bind(car);
    car.writeDid = async (module, did, bytes, options) => {
      options.onNote?.({ step: 'session-open', detail: 'open a coding session: 50 03' });
      options.onNote?.({ step: 'payload', did, detail: 'send 1/3' });
      return write(module, did, bytes, options);
    };
    const events = await run(apply(), deps);
    expect(events.filter((e) => e.type === 'writer')).toMatchObject([
      { step: 'session-open', detail: 'open a coding session: 50 03' },
      { step: 'payload', did: '0A5E', detail: 'send 1/3' },
    ]);
    expect(types(events).indexOf('writer')).toBeLessThan(types(events).indexOf('request-sent'));
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
  });

  it('has no live-write switch: a live link that can write, writes', async () => {
    const { car, deps } = setup({ mode: 'live', banner: 'live' });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
  });

  it('refuses to write over a link that can only read', async () => {
    const { car, backups, deps } = setup({ mode: 'live', canWrite: false, banner: 'live' });
    expect(events_reason(await run(apply(), deps))).toBe('live-writes-disabled');
    expectNothingSent(car, backups);
  });

  it('honours a cancel made before the write is on the wire', async () => {
    const { car, controller, deps } = setup();
    controller.abort();
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'cancelled' });
    expect(car.writes).toHaveLength(0);
  });

  it('refuses an alt recipe when no variant precondition holds (its DID never answered)', async () => {
    const split: CodingRecipe = {
      id: 'synthetic-split',
      name: 'split',
      kind: 'alt',
      requestId: '70E',
      responseId: '778',
      variants: [
        {
          selector: 'mqb-alt-0a59',
          did: '0A59',
          kind: 'field',
          field: { byteOffset: 0, bitOffset: 2, bitLength: 1, byteOrder: 'big' },
          choices: [
            { id: 'enabled', label: 'On', value: 1 },
            { id: 'disabled', label: 'Off', value: 0 },
          ],
        },
      ],
    };
    const { car, backups, deps } = setup(
      {},
      { recipeFor: () => split, featureFor: offering('enabled', 'disabled') },
    );
    const events = await run(apply('enabled'), deps);
    expect(events_reason(events)).toBe('variant-unsettled');
    // The journal says which reads decided it: 0A59 never answered.
    expect(events.find((e) => e.type === 'variant-refused')).toMatchObject({
      recipeId: 'synthetic-split',
      probe: { reads: { '0A59': 0 } },
    });
    expectNothingSent(car, backups);
  });

  it('journals which variant the module chose, and from which answers', async () => {
    const split: CodingRecipe = {
      id: 'synthetic-split',
      name: 'split',
      kind: 'alt',
      requestId: '70E',
      responseId: '778',
      variants: ['0A59', '0A5E'].map((did) => ({
        selector: `mqb-alt-${did.toLowerCase()}`,
        did,
        kind: 'field' as const,
        field: { byteOffset: 0, bitOffset: 2, bitLength: 1, byteOrder: 'big' as const },
        choices: [
          { id: 'enabled', label: 'On', value: 1 },
          { id: 'disabled', label: 'Off', value: 0 },
        ],
      })),
    };
    const { deps } = setup({}, { recipeFor: () => split, featureFor: offering('enabled', 'disabled') });
    const events = await run(apply('enabled'), deps);
    expect(events.find((e) => e.type === 'variant-selected')).toMatchObject({
      recipeId: 'synthetic-split',
      selector: 'mqb-alt-0a5e',
      did: '0A5E',
      reason: '0A5E answered',
      probe: { reads: { '0A59': 0, '0A5E': 5 } },
    });
  });

  it('refuses a feature that has no recipe (nothing byte-level to write)', async () => {
    const { deps } = setup({}, { featureFor: () => ({ ...feature(), recipeId: undefined }) });
    const req: CodingRequest = {
      kind: 'apply',
      car: CAR,
      feature: { ...feature(), recipeId: undefined },
      settingId: 'value-5',
    };
    expect(events_reason(await run(req, deps))).toBe('invalid-plan');
  });
});

describe('runCoding — vehicle readiness (measured and journaled; a warning, never a refusal)', () => {
  it.each([
    ['engine running', { rpm: 820 }, /engine is running/],
    ['car moving', { speedKmh: 12 }, /moving/],
    ['battery low', { voltage: 10.6 }, /battery is low/],
    ['supply high', { voltage: 16.1 }, /battery charge is unusually high/],
    ['engine speed unreadable', { rpm: null }, /whether the engine is off/],
    ['road speed unreadable', { speedKmh: null }, /whether the car is parked/],
    ['voltage unreadable', { voltage: null }, /couldn't check the battery/],
  ] as const)('warns and still writes: %s', async (_n, readiness, why) => {
    const { car, backups, deps } = setup({ readiness });
    const events = await run(apply(), deps);
    expect(events.find((e) => e.type === 'refused')).toBeUndefined();
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toMatchObject({ code: 'readiness' });
    expect(warning?.type === 'warning' && warning.detail).toMatch(why);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
    expect(backups.records.get('backup-0001')?.readiness?.warning).toMatch(why);
  });

  it('journals the measured values, their age and whether they were in band', async () => {
    const { deps } = setup({ readiness: { rpm: 0, speedKmh: 0, voltage: 12.4 } });
    const events = await run(apply(), deps);
    const ready = events.find((e) => e.type === 'readiness');
    expect(ready).toMatchObject({
      ok: true,
      rpm: 0,
      speedKmh: 0,
      voltage: 12.4,
      measuredAt: expect.any(String),
    });
    expect(ready?.type === 'readiness' && ready.ageMs).toBeGreaterThanOrEqual(0);
    const low = await run(apply(), setup({ readiness: { voltage: 10.6 } }).deps);
    expect(low.find((e) => e.type === 'readiness')).toMatchObject({ ok: false, voltage: 10.6 });
  });

  it('old evidence is not a gate either (no age limit while markers stall)', async () => {
    const { car, deps } = setup({ now: () => new Date(Date.UTC(2026, 9, 24, 11, 58)) });
    expect(outcome(await run(apply(), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
  });

  it('measures readiness for restores too, without refusing', async () => {
    const { car, deps } = setup({ values: { [KEY]: '3E00000000' }, readiness: { rpm: 900 } });
    const b = {
      schema: 'vibecode-my-car.backup/2' as const,
      id: 'orig-0003',
      createdAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T10:00:00.000Z',
      featureId: 'comfort-lane-change-indicator-5-flashes',
      featureName: 'Comfort lane change',
      recipeId: 'live-bcm-polite-blinks',
      settingId: 'value-5',
      settingLabel: '5 blinks',
      car: CAR,
      vin: { masked: 'MEXS…0001', fingerprint: await fingerprintVin(SIM_VIN) },
      module: { request: '70E', response: '778', part: PART },
      did: '0A5E',
      before: '3A00000000',
      intended: '3E00000000',
      status: 'verified' as const,
      operation: 'apply' as const,
      linkMode: 'demo' as const,
      ack: 'received' as const,
      history: [],
      recipeDigest: await recipeDigest(APP_DATA.recipes['live-bcm-polite-blinks'] as Recipe),
    };
    const events = await run({ kind: 'restore', backup: b }, deps);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({ code: 'readiness' });
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '3A00000000' })]);
  });

  it('stores the evidence measured before the write', async () => {
    const { backups, deps } = setup({}, { now: () => new Date() });
    await run(apply(), deps);
    expect(backups.records.get('backup-0001')?.readiness).toMatchObject({
      rpm: 0,
      speedKmh: 0,
      voltage: 12.6,
    });
  });

  it('a link that stops the sequence before the data write reports "not sent", never uncertain', async () => {
    const { car, backups, deps } = setup({}, { now: () => new Date() });
    car.writeDid = async () => ({ kind: 'not-sent', detail: 'The security unlock was refused.' });
    const events = await run(apply(), deps);
    expect(outcome(events)).toMatchObject({ outcome: 'not-sent' });
    expect(backups.records.get('backup-0001')).toMatchObject({ status: 'refused', outcome: 'not-sent' });
  });
});

describe('runCoding — restore', () => {
  async function backup(over: Partial<BackupRecord> = {}): Promise<BackupRecord> {
    return {
      recipeDigest: await recipeDigest(APP_DATA.recipes['live-bcm-polite-blinks'] as Recipe),
      schema: 'vibecode-my-car.backup/2',
      operation: 'apply',
      linkMode: 'demo',
      ack: 'received',
      history: [],
      id: 'orig-0001',
      createdAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T10:00:00.000Z',
      featureId: 'comfort-lane-change-indicator-5-flashes',
      featureName: 'Comfort lane change',
      recipeId: 'live-bcm-polite-blinks',
      settingId: 'value-5',
      settingLabel: '5 blinks',
      car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
      vin: { masked: 'MEXS…0001', fingerprint: await fingerprintVin(SIM_VIN) },
      module: { request: '70E', response: '778', part: PART },
      did: '0A5E',
      before: '3A00000000',
      intended: '3E00000000',
      status: 'verified',
      ...over,
    };
  }

  it('writes the original back, verifies it exactly, and marks the backup restored', async () => {
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00000000' } });
    const b = await backup();
    backups.records.set(b.id, b);
    const events = await run({ kind: 'restore', backup: b }, deps);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(car.values.get(KEY)).toBe('3A00000000');
    expect(backups.records.get('orig-0001')).toMatchObject({ status: 'restored', restoredBy: 'backup-0001' });
    // The restore is its own durable operation, linked to the change it undid.
    expect(backups.records.get('backup-0001')).toMatchObject({
      operation: 'restore',
      restoreOf: 'orig-0001',
      before: '3E00000000',
      intended: '3A00000000',
      status: 'verified',
      outcome: 'verified',
      ack: 'received',
    });
    expect(backups.records.size).toBe(2);
  });

  it('puts back a byte our own write left wrong, even outside the recipe bits (lost CAN frame byte)', async () => {
    // Live: 0A5E byte 2 read back A0 after a write that sent 00 there — the clone dropped the 8th byte of the
    // first frame (no ATAL). The restore undoes that too; a byte the car changed on its own is left alone.
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00A00000' } });
    const b = await backup({ observed: '3E00A00000', ownedMask: '1600000000' });
    backups.records.set(b.id, b);
    const events = await run({ kind: 'restore', backup: b }, deps);
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '3A00000000' })]);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(backups.records.get('backup-0001')).toMatchObject({ intended: '3A00000000' });
  });

  it('leaves a byte the car changed after our write as the car set it', async () => {
    const { car, deps } = setup({ values: { [KEY]: '3E00B00000' } });
    const b = await backup({ observed: '3E00A00000', ownedMask: '1600000000' });
    await run({ kind: 'restore', backup: b }, deps);
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '3A00B00000' })]);
  });

  it('refuses to restore onto a different car', async () => {
    const { car, deps } = setup({ vin: 'MEXOTHER000000009', values: { [KEY]: '3E00000000' } });
    const events = await run({ kind: 'restore', backup: await backup() }, deps);
    expect(events.find((e) => e.type === 'refused')).toMatchObject({ reason: 'wrong-car' });
    expect(car.writes).toHaveLength(0);
  });

  it('names both cars by their full VIN when it refuses a different car', async () => {
    const { deps } = setup({ vin: 'mexother000000009', values: { [KEY]: '3E00000000' } });
    const b = await backup({
      vin: { masked: 'MEXS…0001', fingerprint: await fingerprintVin(SIM_VIN), full: SIM_VIN },
    });
    const refused = (await run({ kind: 'restore', backup: b }, deps)).find((e) => e.type === 'refused');
    const detail = refused && 'detail' in refused ? String(refused.detail) : '';
    expect(detail).toContain('MEXOTHER000000009');
    expect(detail).toContain(SIM_VIN);
  });

  it('restores onto the part the backup names, whatever part any proof names (no proof binding)', async () => {
    const { car, deps } = setup({ parts: { '70E': '2Q0937089X' }, values: { [KEY]: '3E00000000' } });
    const b = await backup({ module: { request: '70E', response: '778', part: '2Q0937089X' } });
    expect(outcome(await run({ kind: 'restore', backup: b }, deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
  });

  it('refuses to restore onto a different control unit', async () => {
    const { car, deps } = setup({ parts: { '70E': '2Q0937089X' }, values: { [KEY]: '3E00000000' } });
    expect(events_reason(await run({ kind: 'restore', backup: await backup() }, deps))).toBe(
      'unknown-module',
    );
    expect(car.writes).toHaveLength(0);
  });

  it('refuses an older backup without a recipe fingerprint: it needs requalification, not a guess', async () => {
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00000000' } });
    const { recipeDigest: _d, ...legacy } = await backup({ linkMode: 'unknown', ack: 'unknown' });
    expect(events_reason(await run({ kind: 'restore', backup: legacy }, deps))).toBe('needs-requalification');
    expect(car.writes).toHaveLength(0);
    expect(backups.records.size).toBe(0);
  });

  it('leaves the original record untouched when the restore is refused', async () => {
    const { backups, deps } = setup({ values: { [KEY]: '3E00000000' }, write: { kind: 'nrc', code: '22' } });
    const b = await backup();
    backups.records.set(b.id, b);
    await run({ kind: 'restore', backup: b }, deps);
    expect(backups.records.get('orig-0001')?.status).toBe('verified');
  });
});

describe('runSession — recheck (read-only follow-up)', () => {
  async function pending(over: Partial<BackupRecord> = {}): Promise<BackupRecord> {
    return {
      schema: 'vibecode-my-car.backup/2',
      operation: 'apply',
      linkMode: 'demo',
      ack: 'received',
      history: [],
      id: 'orig-0002',
      createdAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T10:00:00.000Z',
      featureId: 'comfort-lane-change-indicator-5-flashes',
      featureName: 'Comfort lane change',
      recipeId: 'live-bcm-polite-blinks',
      settingId: 'value-5',
      settingLabel: '5 blinks',
      car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
      vin: { masked: 'MEXS…0001', fingerprint: await fingerprintVin(SIM_VIN) },
      module: { request: '70E', response: '778', part: PART },
      did: '0A5E',
      before: '3A00000000',
      intended: '3E00000000',
      status: 'unconfirmed',
      ...over,
    };
  }

  it('confirms a change that did land, and never writes', async () => {
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00000000' } });
    const b = await pending();
    backups.records.set(b.id, b);
    const events = await run({ kind: 'recheck', backup: b }, deps);
    expect(outcome(events)).toMatchObject({ outcome: 'observed-match' });
    expect(car.writes).toHaveLength(0);
    expect(backups.records.get('orig-0002')).toMatchObject({ status: 'verified', observed: '3E00000000' });
  });

  it('judges a record with a stored mask on the recipe bits, and reports what the module changed', async () => {
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00A00000' } });
    const b = await pending({
      ownedMask: '1600000000',
      recipeDigest: await recipeDigest(APP_DATA.recipes['live-bcm-polite-blinks'] as Recipe),
    });
    backups.records.set(b.id, b);
    const events = await run({ kind: 'recheck', backup: b }, deps);
    expect(outcome(events)).toMatchObject({ outcome: 'observed-match' });
    expect(car.writes).toHaveLength(0);
    expect(backups.records.get('orig-0002')).toMatchObject({
      status: 'verified',
      moduleManaged: [{ offset: 2, wrote: '00', stored: 'A0' }],
    });
  });

  it('judges an older record without a mask on the exact bytes', async () => {
    const { car, backups, deps } = setup({ values: { [KEY]: '3E00A00000' } });
    const b = await pending();
    backups.records.set(b.id, b);
    expect(outcome(await run({ kind: 'recheck', backup: b }, deps))).toMatchObject({ outcome: 'mismatch' });
    expect(car.writes).toHaveLength(0);
    expect(backups.records.get('orig-0002')?.status).toBe('unconfirmed');
  });

  it.each(['refused', 'restored'] as const)(
    'refuses to check a %s record and reads nothing',
    async (status) => {
      const { car, backups, deps } = setup({ values: { [KEY]: '3A00000000' } });
      const b = await pending({ status });
      backups.records.set(b.id, b);
      let reads = 0;
      car.readDid = async () => {
        reads++;
        return { kind: 'ok', bytes: '3A00000000' };
      };
      expect(events_reason(await run({ kind: 'recheck', backup: b }, deps))).toBe('not-checkable');
      expect(reads).toBe(0);
      expect(backups.records.get(b.id)?.status).toBe(status);
    },
  );

  it('a recheck that confirms a restore also resolves the change it undid', async () => {
    const { backups, deps } = setup({ values: { [KEY]: '3A00000000' } });
    const source = await pending({ id: 'orig-0003', status: 'verified' });
    const restore = await pending({
      id: 'rest-0003',
      operation: 'restore',
      restoreOf: 'orig-0003',
      before: '3E00000000',
      intended: '3A00000000',
      status: 'unconfirmed',
    });
    backups.records.set(source.id, source);
    backups.records.set(restore.id, restore);
    expect(outcome(await run({ kind: 'recheck', backup: restore }, deps))).toMatchObject({
      outcome: 'observed-match',
    });
    expect(backups.records.get('orig-0003')).toMatchObject({ status: 'restored', restoredBy: 'rest-0003' });
  });

  it('is uncertain when the value cannot be read', async () => {
    const { deps } = setup({ values: {} });
    expect(outcome(await run({ kind: 'recheck', backup: await pending() }, deps))).toMatchObject({
      outcome: 'pending-uncertain',
    });
  });

  it('refuses to check a different car', async () => {
    const { car, deps } = setup({ vin: 'MEXOTHER000000009', values: { [KEY]: '3E00000000' } });
    expect(events_reason(await run({ kind: 'recheck', backup: await pending() }, deps))).toBe('wrong-car');
    expect(car.writes).toHaveLength(0);
  });

  it('carries the full VIN in the car check of a recheck', async () => {
    const { backups, deps } = setup({ values: { [KEY]: '3E00000000' } });
    const b = await pending();
    backups.records.set(b.id, b);
    const events = await run({ kind: 'recheck', backup: b }, deps);
    expect(events.find((e) => e.type === 'car-verified')).toMatchObject({
      vin: SIM_VIN,
      vinMasked: 'MEXS…0001',
    });
  });
});

describe('catalogue sanity used by these tests', () => {
  it('the fixture recipe is the one the live session proved', () => {
    expect(APP_DATA.recipes['live-bcm-polite-blinks']?.did).toBe('0A5E');
  });
});

function events_reason(events: CodingEvent[]): string | undefined {
  const r = events.find((e) => e.type === 'refused');
  return r?.type === 'refused' ? r.reason : undefined;
}

describe('full-module snapshot (C3.1, S02)', () => {
  it('groups identity and the inventory separately, and still checks readiness and persists the backup before writing', async () => {
    const s = setup({}, { now: () => new Date(Date.UTC(2026, 9, 28, 12)) });
    const groups: string[][] = [];
    const grouped: CarLink = s.car;
    let active = false;
    grouped.withReads = async (_module, work) => {
      const reads: string[] = [];
      groups.push(reads);
      active = true;
      try {
        return await work({
          identify: async (module) => {
            reads.push('VIN');
            return s.car.identify(module);
          },
          readDid: async (module, did) => {
            reads.push(did);
            return s.car.readDid(module, did);
          },
        });
      } finally {
        active = false;
      }
    };
    const readiness = s.car.readiness.bind(s.car);
    s.car.readiness = async () => {
      expect(active).toBe(false);
      return readiness();
    };
    const write = s.car.writeDid.bind(s.car);
    s.car.writeDid = async (...args) => {
      expect(active).toBe(false);
      expect(s.backups.records.get('backup-0001')?.moduleSnapshot?.['0A5E']).toBe('3A00000000');
      return write(...args);
    };
    expect(outcome(await run(apply(), s.deps))).toMatchObject({ outcome: 'verified' });
    expect(groups[0]).toEqual(['VIN', 'F187']);
    const inventory = APP_DATA.backupDids?.['09'] ?? [];
    expect(inventory.length).toBeGreaterThan(200);
    expect(groups[1]).toEqual([...new Set(inventory.filter((d) => d !== '0A5E'))]);
    expect(s.car.writes).toHaveLength(1);
  });

  /** A car whose every non-identity read advances the session clock: a realistic, slow inventory scan. */
  function slowScan(msPerRead: number, sim: SimOptions = {}) {
    let t = Date.UTC(2026, 9, 25, 12);
    const now = () => new Date(t);
    const s = setup({ now, ...sim }, { now });
    const read = s.car.readDid.bind(s.car);
    let scanned = 0;
    s.car.readDid = async (module, did) => {
      if (did !== 'F187' && did !== '0A5E') {
        t += msPerRead;
        scanned++;
      }
      return read(module, did);
    };
    return { ...s, scanned: () => scanned, advance: (ms: number) => (t += ms) };
  }

  it('scans before readiness, so a 45 s scan still codes on fresh evidence; the snapshot is durable before the write', async () => {
    const s = slowScan(150);
    let atWrite: BackupRecord | undefined;
    const write = s.car.writeDid.bind(s.car);
    s.car.writeDid = async (...args) => {
      atWrite = structuredClone(s.backups.records.get('backup-0001'));
      return write(...args);
    };
    const events = await run(apply(), s.deps);
    expect(s.scanned()).toBeGreaterThan(200);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(atWrite?.moduleSnapshot?.['0A5E']).toBe('3A00000000');
    expect(atWrite?.moduleSnapshotPartial).toBeUndefined();
  });

  it('stops at its time budget and records the snapshot as partial', async () => {
    const s = slowScan(1000); // 300 reads × 1 s would take 5 minutes
    const events = await run(apply(), s.deps);
    expect(s.scanned()).toBeLessThanOrEqual(92);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(s.backups.records.get('backup-0001')?.moduleSnapshotPartial).toBe(true);
  });

  it('honours cancellation inside the scan: nothing saved, nothing sent', async () => {
    const s = slowScan(150);
    const read = s.car.readDid.bind(s.car);
    s.car.readDid = async (module, did) => {
      if (s.scanned() === 10) s.controller.abort();
      return read(module, did);
    };
    const events = await run(apply(), s.deps);
    expect(outcome(events)).toMatchObject({ outcome: 'cancelled' });
    expect(s.scanned()).toBeLessThan(15);
    expect(s.car.writes).toHaveLength(0);
    expect(s.backups.records.size).toBe(0);
  });

  it('stops on a lost link: not sent, nothing saved', async () => {
    const s = setup();
    const read = s.car.readDid.bind(s.car);
    let n = 0;
    s.car.readDid = async (module, did) => {
      if (did !== 'F187' && did !== '0A5E' && ++n === 20) throw new Error('GATT error');
      return read(module, did);
    };
    const events = await run(apply(), s.deps);
    expect(types(events)).toContain('link-lost');
    expect(outcome(events)).toMatchObject({ outcome: 'not-sent' });
    expect(n).toBe(20);
    expect(s.car.writes).toHaveLength(0);
    expect(s.backups.records.size).toBe(0);
  });

  it('stops scanning a module that went silent and records it as partial', async () => {
    const s = setup();
    const read = s.car.readDid.bind(s.car);
    let n = 0;
    s.car.readDid = async (module, did) => {
      if (did !== 'F187' && did !== '0A5E') {
        n++;
        return { kind: 'no-reply' };
      }
      return read(module, did);
    };
    await run(apply(), s.deps);
    expect(n).toBe(5);
    expect(s.backups.records.get('backup-0001')?.moduleSnapshotPartial).toBe(true);
  });

  it('refuses when the coded value changed during the scan (the plan was made from the old one)', async () => {
    const s = setup();
    const read = s.car.readDid.bind(s.car);
    let n = 0;
    s.car.readDid = async (module, did) => {
      if (did !== 'F187' && did !== '0A5E' && ++n === 50) s.car.values.set(KEY, '3B00000000');
      return read(module, did);
    };
    const events = await run(apply(), s.deps);
    expect(events.find((e) => e.type === 'refused')).toMatchObject({ reason: 'value-changed' });
    expect(s.car.writes).toHaveLength(0);
    expect(s.backups.records.size).toBe(0);
  });
});

describe('no module binding (owner directive 2026-11-01)', () => {
  /** A recipe nobody has proven on any module: the catalogue offers it as experimental. */
  const unproven: Recipe = {
    ...(APP_DATA.recipes['live-bcm-polite-blinks'] as Recipe),
    id: 'synthetic-unproven',
  };
  const deps = (mode: 'live' | 'demo') => {
    const s = setup(
      { mode, canWrite: true },
      {
        recipeFor: (id) => (id === unproven.id ? unproven : APP_DATA.recipes[id]),
        featureFor: () => ({ ...feature(), tier: 'experimental', proof: undefined, recipeId: unproven.id }),
      },
    );
    return s;
  };
  const req = (): CodingRequest => ({
    kind: 'apply',
    car: CAR,
    feature: { ...feature(), recipeId: unproven.id, proof: undefined },
    settingId: 'value-5',
  });

  it('writes an unproven recipe to a real car (no proof or part binding), with the full backup first', async () => {
    const s = deps('live');
    const events = await run(req(), s.deps);
    expect(events.find((e) => e.type === 'refused')).toBeUndefined();
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(s.car.writes).toHaveLength(1);
    expect(s.backups.records.get('backup-0001')).toMatchObject({
      recipeId: 'synthetic-unproven',
      status: 'verified',
    });
  });

  it('still runs it on a simulated car (no vehicle is involved)', async () => {
    const s = deps('demo');
    expect(outcome(await run(req(), s.deps))).toMatchObject({ outcome: 'verified' });
  });
});

describe('known repairs: a byte an earlier write left wrong on this unit', () => {
  it('puts BCM 0A5E byte 2 back from A0 to 00 while applying, and says so', async () => {
    const { car, deps } = setup({ values: { [KEY]: '3A00A00000' } });
    const events = await run(apply('value-5'), deps);
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '3E00000000' })]);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({ code: 'repair' });
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
  });

  it('repairs even when the setting itself is already as asked', async () => {
    const { car, deps } = setup({ values: { [KEY]: '3E00A00000' } });
    expect(outcome(await run(apply('value-5'), deps))).toMatchObject({ outcome: 'verified' });
    expect(car.writes).toEqual([expect.objectContaining({ bytes: '3E00000000' })]);
  });

  it('touches nothing on another part number, or once the byte is no longer the stray value', async () => {
    const other = setup({ parts: { '70E': '2Q0937089X' }, values: { [KEY]: '3A00A00000' } });
    await run(apply('value-5'), other.deps);
    expect(other.car.writes).toEqual([expect.objectContaining({ bytes: '3E00A00000' })]);
    const clean = setup({ values: { [KEY]: '3A00B00000' } });
    await run(apply('value-5'), clean.deps);
    expect(clean.car.writes).toEqual([expect.objectContaining({ bytes: '3E00B00000' })]);
  });
});
