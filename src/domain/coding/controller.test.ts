import { describe, expect, it, vi } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { findFeature } from '../catalog/features.ts';
import type { CarSelection } from '../catalog/types.ts';
import { BusyError, CodingController } from './controller.ts';
import type { BackupStore, CodingRequest } from './types.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const feature = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
if (!feature) throw new Error('fixture');
const req: CodingRequest = { kind: 'apply', car: CAR, feature, settingId: 'value-5' };

const backups: BackupStore = { save: async () => {}, update: async () => {} };
const sleep = async () => {};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const realSleep = wait;

function controller(sim: ConstructorParameters<typeof SimulatedCar>[0] = {}) {
  const car = new SimulatedCar({
    parts: { '70E': '2Q0937089D' },
    values: { '70E:0A5E': '3A00000000' },
    sleep,
    ...sim,
  });
  const c = new CodingController((signal) => ({
    link: car,
    backups,
    signal,
    sleep,
    readbackDelayMs: 0,
  }));
  return { car, c };
}

describe('CodingController', () => {
  it('runs a session to a final, evidence-based result', async () => {
    const { c } = controller();
    const progress = await c.start(req).done;
    expect(progress.result).toEqual({ kind: 'success', acknowledged: true });
    expect(c.running).toBe(false);
  });

  it('refuses a duplicate submission while one is running (double tap)', async () => {
    const { c } = controller({ latencyMs: 5, sleep: realSleep });
    const first = c.start(req);
    expect(() => c.start(req)).toThrow(BusyError);
    await first.done;
    expect(() => c.start(req).done).not.toThrow();
  });

  it('streams progress to subscribers and stops after unsubscribe', async () => {
    const { c } = controller();
    const seen: string[] = [];
    const off = c.subscribe((p) => seen.push(Object.values(p.steps).join(',')));
    await c.start(req).done;
    expect(seen.length).toBeGreaterThan(3);
    off();
    const before = seen.length;
    await c.start(req).done;
    expect(seen.length).toBe(before);
  });

  it('cancel before the write leaves the car untouched', async () => {
    const { car, c } = controller({ latencyMs: 5, sleep: realSleep });
    const h = c.start(req);
    h.cancel();
    const p = await h.done;
    expect(p.result).toEqual({ kind: 'cancelled' });
    expect(car.writes).toHaveLength(0);
    expect(p.cancelRequested).toBe(true);
  });

  it('a cancel after the request left does NOT abandon the session — it still ends with the real outcome', async () => {
    const { car, c } = controller({ write: { kind: 'ack-after-pending' }, pendingMs: 40, sleep: realSleep });
    let sent!: () => void;
    const onWire = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const off = c.subscribe((progress) => {
      if (progress.sent) sent();
    });
    const h = c.start(req);
    await onWire;
    off();
    h.cancel();
    const p = await h.done;
    expect(car.writes).toHaveLength(1);
    expect(p.cancelRequested).toBe(true);
    expect(p.sent).toBe(true);
    expect(p.result).toEqual({ kind: 'success', acknowledged: true });
  });

  it('frees itself after a session so the next one can start', async () => {
    const { c } = controller();
    await c.start(req).done;
    expect(c.running).toBe(false);
    await expect(c.start(req).done).resolves.toBeDefined();
  });

  it('keeps the record export when storage fails after the send and the experiment log fails too', async () => {
    const car = new SimulatedCar({
      parts: { '70E': '2Q0937089D' },
      values: { '70E:0A5E': '3A00000000' },
      sleep,
    });
    const failingStore: BackupStore = {
      save: async () => {},
      update: async () => {
        throw new Error('QuotaExceededError');
      },
    };
    const c = new CodingController((signal) => ({
      link: car,
      backups: failingStore,
      signal,
      sleep,
      readbackDelayMs: 0,
      // The experiment log lives in the same database, so it fails as soon as anything goes wrong.
      audit: {
        id: 'exp-1',
        start: async () => {},
        append: async (e) => {
          if (e.type === 'audit-failed') throw new Error('QuotaExceededError');
        },
        close: async () => {},
      },
    }));
    const progress = await c.start(req).done;
    expect(progress.result?.kind).toBe('success');
    expect(progress.auditFailure?.record).toMatchObject({ did: '0A5E', intended: '3E00000000' });
  });

  it('a subscriber that throws does not abandon the session', async () => {
    const { c } = controller();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    c.subscribe(() => {
      throw new Error('UI bug');
    });
    const progress = await c.start(req).done;
    expect(progress.result?.kind).toBe('success');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('turns an unexpected exception into an honest outcome, not a hang or false success', async () => {
    const { car, c } = controller();
    car.identify = async () => {
      throw new Error('boom');
    };
    const p = await c.start(req).done;
    expect(p.result?.kind).toBe('refused');
    expect(c.running).toBe(false);
  });
});
