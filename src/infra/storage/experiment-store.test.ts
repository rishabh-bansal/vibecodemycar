import { afterEach, describe, expect, it, vi } from 'vitest';
import { findFeature } from '../../domain/catalog/features.ts';
import type { WireTrace } from '../../domain/coding/audit.ts';
import { CodingController } from '../../domain/coding/controller.ts';
import type { CarLink, CodingRequest } from '../../domain/coding/types.ts';
import { SimulatedCar } from '../link/simulator.ts';
import { DexieBackupStore } from './backup-store.ts';
import { ObdcraftDb } from './db.ts';
import { ExperimentRecorder, unsavedExperiments } from './experiment-store.ts';

const car = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
} as const;
const feature = findFeature(car, 'comfort-lane-change-indicator-5-flashes');
if (!feature) throw Error('fixture');
const request: CodingRequest = { kind: 'apply', car, feature, settingId: 'value-5' };
const databases: ObdcraftDb[] = [];

function setup(options: ConstructorParameters<typeof SimulatedCar>[0] = {}) {
  const database = new ObdcraftDb(`experiments-${crypto.randomUUID()}`);
  databases.push(database);
  const link = new SimulatedCar({
    parts: { '70E': '2Q0937089D' },
    values: { '70E:0A5E': '3A00000000' },
    sleep: async () => {},
    ...options,
  });
  const audit = new ExperimentRecorder(link, () => database);
  const controller = new CodingController((signal) => ({
    link,
    audit,
    signal,
    backups: new DexieBackupStore(() => database),
    sleep: async () => {},
    readbackDelayMs: 0,
  }));
  return { database, link, audit, controller };
}

afterEach(async () => {
  vi.restoreAllMocks();
  unsavedExperiments.clear();
  for (const database of databases.splice(0)) await database.delete();
});

describe('durable experiment evidence', () => {
  it('saves recipe, setting, raw before/intended/observed bytes and final outcome for reload', async () => {
    const { controller, database, audit } = setup();
    await controller.start(request).done;
    const record = await database.experiments.get(audit.id);
    expect(record).toMatchObject({
      mode: 'demo',
      state: 'complete',
      needsAttention: false,
      settingId: 'value-5',
      backup: {
        before: '3A00000000',
        intended: '3E00000000',
        observed: '3E00000000',
        outcome: 'verified',
        ack: 'received',
      },
    });
    expect(record?.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.events.some((e) => e.type === 'request-sent')).toBe(true);
    database.close();
    await database.open();
    expect((await database.experiments.get(audit.id))?.state).toBe('complete');
  });

  it('stamps the commit and version, and keeps the writer notes and readiness values', async () => {
    const { controller, database, audit, link } = setup();
    const write = link.writeDid.bind(link);
    link.writeDid = async (module, did, bytes, options) => {
      options.onNote?.({ step: 'payload', did, detail: 'send 1/3' });
      return write(module, did, bytes, options);
    };
    await controller.start(request).done;
    const record = await database.experiments.get(audit.id);
    expect(record?.gitSha).toMatch(/^(?:[0-9a-f]{4,40}(?:-dirty)?|unknown)$/);
    expect(record?.version).toEqual(expect.any(String));
    expect(record?.events).toContainEqual(
      expect.objectContaining({ type: 'writer', step: 'payload', did: '0A5E', detail: 'send 1/3' }),
    );
    expect(record?.events).toContainEqual(expect.objectContaining({ type: 'readiness', ok: true }));
  });

  it('flags exact read-back mismatches without treating an ACK as success', async () => {
    const { controller, database, audit } = setup({ write: { kind: 'ack-stores', bytes: '3C00000000' } });
    await controller.start(request).done;
    expect(await database.experiments.get(audit.id)).toMatchObject({
      needsAttention: true,
      backup: { outcome: 'mismatch', observed: '3C00000000' },
    });
  });

  it('flags a change outside the recipe that nobody has recorded, even with the setting read back as written', async () => {
    const { controller, database, audit } = setup({ write: { kind: 'ack-stores', bytes: '3E00DEADBE' } });
    await controller.start(request).done;
    expect(await database.experiments.get(audit.id)).toMatchObject({
      needsAttention: true,
      backup: { outcome: 'mismatch', observed: '3E00DEADBE' },
    });
  });

  it('keeps a recognised change outside the setting (A0) flagged for review, though the setting verified', async () => {
    const { controller, database, audit } = setup({ write: { kind: 'ack-stores', bytes: '3E00A00000' } });
    await controller.start(request).done;
    expect(await database.experiments.get(audit.id)).toMatchObject({
      needsAttention: true,
      backup: { outcome: 'verified', observed: '3E00A00000' },
    });
  });

  it('refuses before any vehicle I/O if the initial experiment record cannot be persisted', async () => {
    const { controller, database, link } = setup();
    const identify = vi.spyOn(link, 'identify');
    vi.spyOn(database.experiments, 'add').mockRejectedValue(Error('disk full'));
    await controller.start(request).done;
    expect(identify).not.toHaveBeenCalled();
    expect(link.writes).toHaveLength(0);
  });

  it('preserves the real result and offers a downloadable copy when later log saves fail', async () => {
    const { controller, database, link, audit } = setup();
    vi.spyOn(database.experiments, 'put').mockRejectedValue(Error('disk full'));
    const result = await controller.start(request).done;
    expect(result.result).toEqual({ kind: 'success', acknowledged: true });
    expect(link.writes).toHaveLength(1);
    expect(unsavedExperiments.get(audit.id)).toMatchObject({
      state: 'complete',
      backup: { outcome: 'verified' },
    });
  });

  it('retains a newer in-memory backup result when its database update fails', async () => {
    const { controller, database, audit } = setup();
    vi.spyOn(database.backups, 'put').mockRejectedValue(Error('backup update failed'));
    await controller.start(request).done;
    expect((await database.experiments.get(audit.id))?.backup).toMatchObject({
      outcome: 'verified',
      observed: '3E00000000',
    });
  });

  it('logs wire traffic from the start (identification included), caps memory, and unsubscribes', async () => {
    const { database, link } = setup();
    let listener: ((e: WireTrace) => void) | undefined;
    const unsubscribe = vi.fn();
    const observed: CarLink = Object.assign(link, {
      observeWire: (fn: (e: WireTrace) => void) => {
        listener = fn;
        return unsubscribe;
      },
    });
    const audit = new ExperimentRecorder(observed, () => database);
    await audit.start(request);
    expect(listener).toBeDefined();
    const at = new Date().toISOString();
    await audit.append({ type: 'car-verified', at, part: '2Q0937089D', vinMasked: 'TEST…0001' });
    for (let i = 0; i < 4002; i++) listener?.({ at, elapsedMs: i, direction: 'tx', text: '03220A5E' });
    await audit.append({ type: 'outcome', at, outcome: 'pending-uncertain', phase: 'No final reply' });
    await audit.close();
    const record = await database.experiments.get(audit.id);
    expect(record?.wire).toHaveLength(4000);
    expect(record?.traceTruncated).toBe(true);
    expect(record?.needsAttention).toBe(true);
    expect(unsubscribe).toHaveBeenCalled();
  });
});
