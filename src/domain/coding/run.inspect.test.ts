import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { APP_DATA } from '../catalog/data.ts';
import { featureDids, SCAN_TARGETS } from '../catalog/modules.ts';
import type { CarSelection } from '../catalog/types.ts';
import { foldEvents } from './progress.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { BackupStore, CodingEvent, CodingRequest } from './types.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const target = (unit: string) => {
  const t = SCAN_TARGETS[unit];
  if (!t) throw new Error(`no scan target ${unit}`);
  return t;
};
const INVENTORY = APP_DATA.backupDids?.['09'] ?? [];
const toHex = (s: string) =>
  [...s]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

const inspect = (unit = '09'): Extract<CodingRequest, { kind: 'inspect' }> => ({
  kind: 'inspect',
  car: CAR,
  module: target(unit).module,
  unit,
  label: target(unit).label,
});

class MemoryBackups implements BackupStore {
  records = new Map();
  async save() {}
  async update() {}
}

function setup(values: Record<string, string> = {}) {
  let ticks = 0;
  const now = () => new Date(Date.UTC(2026, 9, 24, 12, 0, ticks++));
  const car = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values, now });
  const controller = new AbortController();
  const deps: CodingDeps = {
    link: car,
    backups: new MemoryBackups(),
    signal: controller.signal,
    now,
    sleep: async () => {},
  };
  return { car, controller, deps };
}

async function run(req: CodingRequest, deps: CodingDeps): Promise<CodingEvent[]> {
  const out: CodingEvent[] = [];
  for await (const e of runSession(req, deps)) out.push(e);
  return out;
}

const scanOf = (events: CodingEvent[]) => events.find((e) => e.type === 'module-scan');
const outcomeOf = (events: CodingEvent[]) => events.find((e) => e.type === 'outcome');

describe('runInspect — read-only module inventory', () => {
  it('carries the full VIN in its car check', async () => {
    const { deps } = setup({ '70E:0A5E': '3E00A00000' });
    const events = await run(inspect(), deps);
    expect(events.find((e) => e.type === 'car-verified')).toMatchObject({ vin: 'MEXSIM00000000001' });
  });

  it('walks the whole unit-09 list and buckets every identifier', async () => {
    const { deps } = setup({
      '70E:0A5E': '3E00A00000',
      '70E:0A57': '00',
      '70E:F19E': toHex('EV_BCMA0'),
    });
    const events = await run(inspect(), deps);

    expect(events.map((e) => e.type)).toEqual([
      'verify-started',
      'car-verified',
      'check-started',
      'module-scan',
      'feature-report',
      'readback',
      'outcome',
    ]);
    const scan = scanOf(events);
    expect(scan).toMatchObject({ unit: '09', part: '2Q0937089D', odx: 'EV_BCMA0', complete: true });
    expect(scan?.answered).toMatchObject({ '0A5E': '3E00A00000', '0A57': '00' });
    // Unlisted DIDs on the sim answer NRC 31: the rest of the inventory is "not hosted", none silent.
    expect(Object.keys(scan?.refused ?? {}).length).toBe(INVENTORY.length - 2);
    expect(scan?.silent).toEqual([]);
    expect(outcomeOf(events)).toMatchObject({ outcome: 'verified' });
    // The report decodes hosted recipes: 0A5E byte0 bits1-2 = 3 → the car's current blink count.
    const report = events.find((e) => e.type === 'feature-report');
    expect(report?.entries.find((e) => e.recipeId === 'live-bcm-polite-blinks')).toMatchObject({
      state: { kind: 'value', did: '0A5E', value: 3, choiceId: 'value-5' },
    });
    // A recipe whose variant DIDs all refused is "not hosted"; one with no field spec is "unmapped".
    expect(report?.entries.some((e) => e.state.kind === 'not-hosted')).toBe(true);
    expect(report?.entries.some((e) => e.state.kind === 'unmapped')).toBe(true);
  });

  it('stops partial after a silence streak and saves the partial map', async () => {
    const { car, deps } = setup({ '70E:0A5E': '3E00A00000' });
    const real = car.readDid.bind(car);
    let goSilent = false;
    car.readDid = async (module, did) => {
      if (!goSilent) {
        const r = await real(module, did);
        if (did === '0A5E') goSilent = true; // everything read after 0A5E goes quiet
        return r;
      }
      return { kind: 'no-reply' };
    };
    const events = await run(inspect(), deps);
    const scan = scanOf(events);
    expect(scan?.complete).toBe(false);
    expect(scan?.answered).toMatchObject({ '0A5E': '3E00A00000' });
    expect(scan?.silent.length).toBe(8);
    expect(outcomeOf(events)).toMatchObject({ outcome: 'pending-uncertain' });
  });

  it('scans every fitted unit in one session when the request is all', async () => {
    const unit17Did = APP_DATA.backupDids?.['17']?.[0];
    expect(unit17Did).toBeTruthy();
    const { car, deps } = setup({
      '70E:0A5E': '3E00A00000',
      [`714:${unit17Did}`]: '01',
    });
    // Only the BCM and the cluster answer the presence read: every other address is not fitted.
    (car as unknown as { opts: { parts: Record<string, string> } }).opts.parts['714'] = '6JM920310';
    const req = { ...inspect(), unit: 'all', label: 'all control units' };
    const events = await run(req, deps);

    const discovery = events.find((e) => e.type === 'scan-discovery');
    expect(
      discovery?.type === 'scan-discovery' && discovery.units.filter((u) => u.fitted).map((u) => u.unit),
    ).toEqual(['09', '17']);
    const scans = events.filter((e) => e.type === 'module-scan');
    expect(scans.map((s) => s.unit)).toEqual(['09', '17']);
    expect(scans.find((s) => s.unit === '09')).toMatchObject({
      part: '2Q0937089D',
      complete: true,
      answered: { '0A5E': '3E00A00000' },
    });
    // The reports aggregate across units; progress folds them into one list.
    const reports = events.filter((e) => e.type === 'feature-report');
    expect(reports.length).toBe(scans.length);
    const folded = foldEvents(events);
    expect(folded.report?.some((e) => e.unit === '09' && e.recipeId === 'live-bcm-polite-blinks')).toBe(true);
    expect(folded.scan).toMatchObject({ answered: 4, complete: true });
    const map = events.find((e) => e.type === 'car-map');
    expect(map?.type === 'car-map' && map.map.totals).toMatchObject({ fitted: 2, values: 4 });
    expect(outcomeOf(events)).toMatchObject({ outcome: 'verified' });
  });

  it("probes the unit's recipe identifiers before the manifest tail", async () => {
    const { car, deps } = setup({ '70E:0A5E': '3E00A00000' });
    const reads: string[] = [];
    const real = car.readDid.bind(car);
    car.readDid = async (module, did) => {
      reads.push(did);
      return real(module, did);
    };
    await run(inspect(), deps);
    // The queue walk (everything after the identify part/ODX reads) starts with the recipe DIDs —
    // an adapter that dies ~40 reads in still resolves every feature on the unit.
    const walked = reads.filter((d) => d !== 'F187' && d !== 'F19E');
    const priority = featureDids('09', '70E');
    expect(walked.slice(0, priority.length)).toEqual(priority);
  });

  it('stops a full scan early when the link dies mid-unit', async () => {
    const { car, deps } = setup({ '70E:0A5E': '3E00A00000' });
    (car as unknown as { opts: { parts: Record<string, string> } }).opts.parts['714'] = '6JM920310';
    const real = car.readDid.bind(car);
    car.readDid = async (module, did) => {
      const r = await real(module, did);
      // Die while reading the second fitted unit (17): the first unit's map is kept, the rest never happens.
      if (module.request === '714' && did !== 'F187') return { kind: 'link-lost' };
      return r;
    };
    const req = { ...inspect(), unit: 'all', label: 'all control units' };
    const events = await run(req, deps);
    const scans = events.filter((e) => e.type === 'module-scan');
    expect(scans.length).toBe(2);
    expect(events.find((e) => e.type === 'link-lost')).toBeTruthy();
    expect(outcomeOf(events)).toMatchObject({ outcome: 'pending-uncertain' });
  });

  it('refuses a unit with no identifier list before touching the car', async () => {
    const { deps } = setup();
    const req = inspect();
    req.unit = 'ZZ';
    const events = await run(req, deps);
    expect(events.find((e) => e.type === 'refused')).toMatchObject({ reason: 'invalid-plan' });
    expect(outcomeOf(events)).toMatchObject({ outcome: 'not-sent' });
  });

  it('reports link loss at identify as not-sent', async () => {
    const { car, deps } = setup();
    car.identify = async () => ({ kind: 'link-lost' });
    const events = await run(inspect(), deps);
    expect(events.map((e) => e.type)).toEqual(['verify-started', 'link-lost', 'outcome']);
    expect(outcomeOf(events)).toMatchObject({ outcome: 'not-sent' });
  });
});
