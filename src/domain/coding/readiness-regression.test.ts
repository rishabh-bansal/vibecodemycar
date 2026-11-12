import { expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { findFeature } from '../catalog/features.ts';
import { type CodingDeps, checkReadiness, measureReadiness, runSession } from './run.ts';

it('L3a: slow collection must not label newly sampled readiness as future evidence', async () => {
  const link = new SimulatedCar();
  const started = new Date('2026-10-24T00:00:00Z');
  let now = started;
  link.readiness = async () => {
    now = new Date(started.getTime() + 6000);
    return { kind: 'ok', at: now.toISOString(), rpm: 0, speedKmh: 0, voltage: 12.7 };
  };
  // Inject a clock: now must be sampled after the asynchronous collection, as runCoding now does.
  expect(await checkReadiness(link, () => now)).toMatchObject({ ok: true });
});

it('L3b: a slow durable backup no longer expires readiness — it is measured evidence, not a permit', async () => {
  const car = {
    brand: 'skoda',
    model: 'kushaq',
    variant: 'monte-carlo',
    year: 2023,
    cluster: 'digital',
  } as const;
  const feature = findFeature(car, 'comfort-lane-change-indicator-5-flashes');
  if (!feature) throw new Error('fixture');
  const link = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3A00000000' } });
  let now = Date.parse('2026-10-24T00:00:00Z');
  link.readiness = async () => ({
    kind: 'ok',
    at: new Date(now).toISOString(),
    rpm: 0,
    speedKmh: 0,
    voltage: 12.7,
  });
  const deps: CodingDeps = {
    link,
    signal: new AbortController().signal,
    now: () => new Date(now),
    newId: () => 'backup-late',
    backups: {
      save: async () => {
        now += 31000;
      },
      update: async () => {},
    },
    sleep: async () => {},
    readbackDelayMs: 0,
  };
  let last: unknown;
  for await (const event of runSession({ kind: 'apply', car, feature, settingId: 'value-5' }, deps))
    last = event;
  expect(link.writes).toHaveLength(1);
  expect(last).toMatchObject({ type: 'outcome', outcome: 'verified' });
});

it('readiness out of band is reported, never a refusal', async () => {
  const link = new SimulatedCar();
  link.readiness = async () => ({
    kind: 'ok',
    at: new Date().toISOString(),
    rpm: 900,
    speedKmh: null,
    voltage: 11.9,
  });
  const m = await measureReadiness(link, () => new Date());
  expect(m.lost).toBe(false);
  expect(m.evidence).toMatchObject({ rpm: 900, speedKmh: null, voltage: 11.9 });
  expect(m.warning).toMatch(/engine is running.*couldn't tell whether the car is parked/);
});
