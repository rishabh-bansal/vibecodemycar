/**
 * F43 was: a recipe proven on a specific module part is written only on that part. Owner directive 2026-11-01
 * removed part binding: any part is written, and the part actually coded is journaled with the backup.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { findFeature } from '../catalog/features.ts';
import type { CarSelection } from '../catalog/types.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { CodingEvent } from './types.ts';

const ANALOGUE: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'analogue',
};

async function attempt(part: string) {
  const feature = findFeature(ANALOGUE, 'comfort-lane-change-indicator-5-flashes');
  if (feature?.tier !== 'experimental') throw new Error('fixture: blinks should be experimental here');
  const car = new SimulatedCar({
    parts: { '70E': part },
    values: { '70E:0A5E': '3A00000000' },
    sleep: async () => {},
  });
  const deps: CodingDeps = {
    link: car,
    signal: new AbortController().signal,
    sleep: async () => {},
    readbackDelayMs: 0,
    backups: { save: async (_b: BackupRecord) => {}, update: async () => {} },
  };
  const events: CodingEvent[] = [];
  for await (const e of runSession({ kind: 'apply', car: ANALOGUE, feature, settingId: 'value-5' }, deps))
    events.push(e);
  return { car, events };
}

describe('experimental features are not scoped to a proven module part', () => {
  it('writes another control unit version too, journaling the part it found', async () => {
    const { car, events } = await attempt('2Q0937089X');
    expect(events.find((e) => e.type === 'refused')).toBeUndefined();
    expect(events.find((e) => e.type === 'car-verified')).toMatchObject({ part: '2Q0937089X' });
    expect(events.at(-1)).toMatchObject({ type: 'outcome', outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
  });

  it('writes on the proven part', async () => {
    const { car, events } = await attempt('2Q0937089D');
    expect(events.at(-1)).toMatchObject({ type: 'outcome', outcome: 'verified' });
    expect(car.writes).toHaveLength(1);
  });
});
