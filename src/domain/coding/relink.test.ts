/**
 * Adapter relink and rerun coverage: a dropped adapter can be re-established without the picker,
 * but a session may only continue while the event stream PROVES nothing mutation-capable left for
 * the car. Read-only scans resume mid-list; coding runs rerun from the top, bounded.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { findFeature } from '../catalog/features.ts';
import { featureDids } from '../catalog/modules.ts';
import { reportFeatures } from './report.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { CarLink, CodingEvent, CodingRequest, DidRead } from './types.ts';

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

function fixture() {
  const link = new SimulatedCar({
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

const outcome = (events: CodingEvent[]) => events.at(-1);
const relinks = (events: CodingEvent[]) => events.filter((e) => e.type === 'relink');

describe('coding rerun after a provably-unsent drop', () => {
  it('a link lost before the payload runs the whole ritual again on the fresh link', async () => {
    const f = fixture();
    f.link.writeDid = async () => ({ kind: 'link-lost' });
    const second = new SimulatedCar({
      parts: { '70E': '2Q0937089D' },
      values: { '70E:0A5E': '3A00000000' },
    });
    f.deps.relink = async () => second;
    const events = await run(request, f.deps);
    expect(relinks(events)).toHaveLength(1);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(second.writes).toHaveLength(1);
    // The held "pending" outcome of the dead attempt is never reported — the rerun's stands.
    expect(events.filter((e) => e.type === 'outcome')).toHaveLength(1);
  });

  it('a pre-payload ritual stop (marker went unanswered) reruns on the fresh link', async () => {
    const f = fixture();
    f.link.writeDid = async () => ({ kind: 'not-sent', detail: 'The coding-date write got no answer.' });
    const second = new SimulatedCar({
      parts: { '70E': '2Q0937089D' },
      values: { '70E:0A5E': '3A00000000' },
    });
    f.deps.relink = async () => second;
    const events = await run(request, f.deps);
    expect(relinks(events)).toHaveLength(1);
    expect(outcome(events)).toMatchObject({ outcome: 'verified' });
    expect(second.writes).toHaveLength(1);
  });

  it('never reruns once the payload is on the wire — the uncertain outcome stands', async () => {
    const f = fixture();
    let relinkCalls = 0;
    f.link.writeDid = async (_m, _d, _b, options) => {
      options.onSend?.();
      return { kind: 'link-lost' };
    };
    f.deps.relink = async () => {
      relinkCalls += 1;
      return new SimulatedCar();
    };
    const events = await run(request, f.deps);
    expect(events.some((e) => e.type === 'request-sent')).toBe(true);
    expect(relinkCalls).toBe(0);
    expect(relinks(events)).toHaveLength(0);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
  });

  it('never reruns on a definitive refusal (a mismatched request is not a flaky link)', async () => {
    const f = fixture();
    f.deps.relink = async () => {
      throw new Error('relink must not be called for a refusal');
    };
    const events = await run(request, {
      ...f.deps,
      featureFor: () => ({ ...feature, recipeId: 'some-other-recipe' }),
    });
    expect(outcome(events)).toMatchObject({ outcome: 'not-sent' });
    expect(relinks(events)).toHaveLength(0);
  });

  it('stops rerunning after the bound — the last outcome is reported, not hidden', async () => {
    const f = fixture();
    f.link.writeDid = async () => ({ kind: 'not-sent', detail: 'silent' });
    const makeLost = () => {
      const l = new SimulatedCar({
        parts: { '70E': '2Q0937089D' },
        values: { '70E:0A5E': '3A00000000' },
      });
      l.writeDid = async () => ({ kind: 'not-sent', detail: 'silent' });
      return l;
    };
    let relinkCalls = 0;
    f.deps.relink = async () => {
      relinkCalls += 1;
      return makeLost();
    };
    const events = await run(request, f.deps);
    expect(relinkCalls).toBe(2); // RERUN_MAX — three passes total, then the outcome stands.
    expect(relinks(events)).toHaveLength(2);
    expect(outcome(events)).toMatchObject({ outcome: 'not-sent' });
  });

  it('without a relink path the first outcome stands as before', async () => {
    const f = fixture();
    f.link.writeDid = async () => ({ kind: 'link-lost' });
    const events = await run(request, f.deps);
    expect(relinks(events)).toHaveLength(0);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
  });
});

// ---- inspect: silent retry, relink resume, unprobed tails --------------------------------

const unit = '44';
const module44 = { request: '712', response: '77C' };
const inventory = [...new Set(APP_DATA.backupDids?.[unit] ?? [])];
if (!inventory.length) throw new Error('fixture unit has no inventory');
const didBytes = '01'.padEnd(40, '0');

function inspectFixture() {
  const values: Record<string, string> = {};
  for (const did of inventory) values[`${module44.request}:${did}`] = didBytes;
  const link = new SimulatedCar({
    parts: { [module44.request]: '5QR909144C' },
    values,
  });
  const deps: CodingDeps = {
    link,
    signal: new AbortController().signal,
    sleep: async () => {},
    backups: { save: async () => {}, update: async () => {} },
  };
  const req: CodingRequest = { kind: 'inspect', car, module: module44, unit, label: 'power steering' };
  return { link, deps, req };
}

describe('inspect scan resilience', () => {
  it('a DID silent on the first pass is re-read once — answering moves it out of silent', async () => {
    const f = inspectFixture();
    const quiet = inventory[0] as string;
    const real = f.link.readDid.bind(f.link);
    let calls = 0;
    f.link.readDid = async (m, did) => {
      if (did === quiet && calls++ === 0) return { kind: 'no-reply' };
      return real(m, did);
    };
    const events = await run(f.req, f.deps);
    const scan = events.find((e) => e.type === 'module-scan');
    expect(scan).toMatchObject({ complete: true });
    if (scan?.type !== 'module-scan') throw new Error('no scan event');
    expect(scan.answered[quiet]).toBe(didBytes);
    expect(scan.silent).not.toContain(quiet);
    expect(calls).toBe(2);
  });

  it('a mid-scan drop relinks and resumes at the lost DID — the list is not restarted', async () => {
    const f = inspectFixture();
    const dropAt = 3; // index into the inventory where the link dies
    const real = f.link.readDid.bind(f.link);
    let inventoryReads = 0;
    f.link.readDid = async (m, did): Promise<DidRead> => {
      if (did !== 'F187' && did !== 'F19E') {
        if (inventoryReads++ === dropAt) return { kind: 'link-lost' };
      }
      return real(m, did);
    };
    const second = new SimulatedCar({
      parts: { [module44.request]: '5QR909144C' },
      values: Object.fromEntries(inventory.map((d) => [`${module44.request}:${d}`, didBytes])),
    });
    const secondReads: string[] = [];
    const secondReal = second.readDid.bind(second);
    second.readDid = async (m, did) => {
      secondReads.push(did);
      return secondReal(m, did);
    };
    f.deps.relink = async () => second;
    const events = await run(f.req, f.deps);
    expect(relinks(events)).toHaveLength(1);
    const scan = events.find((e) => e.type === 'module-scan');
    if (scan?.type !== 'module-scan') throw new Error('no scan event');
    expect(scan.complete).toBe(true);
    expect(Object.keys(scan.answered)).toHaveLength(inventory.length);
    // The fresh link's first DID read is the one the dead link never finished (recipe DIDs walk first).
    const priority = [...new Set(featureDids(unit, module44.request))].sort();
    const order = [...priority, ...inventory.filter((d) => !priority.includes(d))];
    expect(secondReads[0]).toBe(order[dropAt]);
  });

  it('a drop with no relink reports the partial map and leaves the tail unprobed, not "not-hosted"', async () => {
    const f = inspectFixture();
    const dropAt = 2;
    const real = f.link.readDid.bind(f.link);
    let inventoryReads = 0;
    f.link.readDid = async (m, did): Promise<DidRead> => {
      if (did !== 'F187' && did !== 'F19E' && inventoryReads++ >= dropAt) return { kind: 'link-lost' };
      return real(m, did);
    };
    const events = await run(f.req, f.deps);
    expect(outcome(events)).toMatchObject({ outcome: 'pending-uncertain' });
    const scan = events.find((e) => e.type === 'module-scan');
    if (scan?.type !== 'module-scan') throw new Error('no scan event');
    expect(Object.keys(scan.answered)).toHaveLength(dropAt);
    const report = events.find((e) => e.type === 'feature-report');
    if (report?.type !== 'feature-report') throw new Error('no report event');
    // Every recipe whose DID sits in the never-reached tail reports 'unprobed', not absence.
    const tail = new Set(inventory.slice(dropAt));
    for (const entry of report.entries) {
      if (entry.state.kind === 'unprobed') expect(entry.state.dids.every((d) => tail.has(d))).toBe(true);
    }
  });

  it('relentless drops exhaust the relink bound and report the partial map', async () => {
    const f = inspectFixture();
    f.link.readDid = async (): Promise<DidRead> => ({ kind: 'link-lost' });
    let relinkCalls = 0;
    f.deps.relink = async (): Promise<CarLink> => {
      relinkCalls += 1;
      const l = new SimulatedCar({ parts: { [module44.request]: '5QR909144C' } });
      l.readDid = async (): Promise<DidRead> => ({ kind: 'link-lost' });
      return l;
    };
    const events = await run(f.req, f.deps);
    expect(relinkCalls).toBe(3); // INSPECT_RELINK_MAX — then the drop stands as the outcome.
    expect(outcome(events)).toMatchObject({ outcome: 'not-sent' });
  });
});

describe('feature report classification', () => {
  it('an unanswered variant DID is "unprobed" — never reported as absent from the unit', () => {
    const recipe = Object.values(APP_DATA.recipes).find(
      (r) => r.unit === unit && r.requestId === module44.request && r.did && r.field,
    );
    if (!recipe?.did) throw new Error('fixture recipe missing');
    const entries = reportFeatures(unit, module44.request, {}, new Set([recipe.did]));
    const entry = entries.find((e) => e.recipeId === recipe.id);
    expect(entry?.state).toMatchObject({ kind: 'unprobed', dids: [recipe.did] });
  });

  it('a probed-but-unanswered landscape still reports not-hosted', () => {
    const entries = reportFeatures(unit, module44.request, {}, new Set());
    for (const entry of entries) expect(['not-hosted', 'unmapped']).toContain(entry.state.kind);
  });
});
