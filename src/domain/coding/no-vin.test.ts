/**
 * F70 (live 2026-10-25): the VIN is read the native tool's way — the module being coded first, then the cluster —
 * and a car that does not answer at all is told apart from one that answered without a VIN.
 */
import { describe, expect, it, vi } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { findFeature } from '../catalog/features.ts';
import { noVinMessage, runSession } from './run.ts';
import type { CodingEvent } from './types.ts';

const CAR = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
} as const;
const BLINKS = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
if (!BLINKS) throw new Error('fixture');

async function run(link: SimulatedCar): Promise<CodingEvent[]> {
  const events: CodingEvent[] = [];
  for await (const e of runSession(
    { kind: 'apply', car: CAR, feature: BLINKS as NonNullable<typeof BLINKS>, settingId: 'value-5' },
    {
      link,
      signal: new AbortController().signal,
      sleep: async () => {},
      readbackDelayMs: 0,
      backups: { save: async () => {}, update: async () => {} },
    },
  ))
    events.push(e);
  return events;
}

describe('the VIN read (F70)', () => {
  it('asks the control unit being coded first — the BCM for the blink count', async () => {
    const link = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3A00000000' } });
    const identify = vi.spyOn(link, 'identify');
    await run(link);
    expect(identify).toHaveBeenCalledWith({ request: '70E', response: '778' });
  });

  it('a car that does not answer at all is refused with what the adapter said, and nothing is sent', async () => {
    const link = new SimulatedCar({ parts: { '70E': '2Q0937089D' }, values: { '70E:0A5E': '3A00000000' } });
    vi.spyOn(link, 'identify').mockResolvedValue({
      kind: 'no-vin',
      why: 'bus-silent',
      adapter: 'UNABLE TO CONNECT',
    });
    const write = vi.spyOn(link, 'writeDid');
    const events = await run(link);
    expect(events.find((e) => e.type === 'refused')).toMatchObject({
      reason: 'no-vin',
      detail: expect.stringContaining("your car didn't answer"),
      technical: expect.stringContaining('the adapter reported "UNABLE TO CONNECT"'),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('a silent module identity is a warning that keeps the NO DATA reason; the silent coded DID then stops it', async () => {
    const link = new SimulatedCar({ parts: { '70E': '2Q0937089D' } });
    vi.spyOn(link, 'readDid').mockResolvedValue({ kind: 'no-reply', adapter: 'NO DATA' });
    const events = await run(link);
    expect(events.find((e) => e.type === 'car-verified')).toMatchObject({ part: 'unknown' });
    expect(events.find((e) => e.type === 'warning')).toMatchObject({
      code: 'identity',
      detail: expect.stringContaining("We couldn't identify this part of your car"),
      technical: expect.stringContaining('The adapter reported "NO DATA"'),
    });
    // The DID read itself is silent too: nothing to back up, so nothing is written.
    expect(events.find((e) => e.type === 'refused')).toMatchObject({ reason: 'module-silent' });
    expect(link.writes).toHaveLength(0);
  });

  it('an unidentified module is still coded, and the backup records its part as unknown', async () => {
    const link = new SimulatedCar({ parts: {}, values: { '70E:0A5E': '3A00000000' } });
    const events = await run(link);
    expect(events.find((e) => e.type === 'warning')).toMatchObject({ code: 'identity' });
    expect(events.at(-1)).toMatchObject({ outcome: 'verified' });
    expect(link.writes).toHaveLength(1);
  });

  it('explains each case in plain words, always saying nothing was changed', () => {
    const cases = [
      noVinMessage({ kind: 'no-vin', why: 'bus-silent', adapter: 'CAN ERROR' }),
      noVinMessage({ kind: 'no-vin', why: 'no-answer' }),
      noVinMessage({ kind: 'no-vin', why: 'no-vin' }),
      noVinMessage({ kind: 'no-vin' }),
    ];
    expect(cases[0]).toMatch(/your car didn't answer.*wait about a minute/);
    expect(cases[0]).not.toContain('CAN ERROR');
    expect(cases[1]).toMatch(/didn't tell us its VIN in time/);
    expect(cases[2]).toMatch(/didn't tell us its VIN/);
    for (const c of cases) expect(c).toMatch(/Nothing was changed\.$/);
  });
});
