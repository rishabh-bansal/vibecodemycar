/**
 * Independent review 2026-10-25, R1: a mask carried by a backup record (or an imported file) must never
 * decide a restore or a recheck. Promoted from docs/reviews/2026-10-25/independent/review.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { type BackupRecord, parseBackupFile } from '../backups/schema.ts';
import { findFeature } from '../catalog/features.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { CodingEvent, CodingRequest } from './types.ts';

const CAR = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
} as const;
const BLINKS = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
if (!BLINKS) throw new Error('fixture');
const KEY = '70E:0A5E';

async function collect(request: CodingRequest, deps: CodingDeps): Promise<CodingEvent[]> {
  const events: CodingEvent[] = [];
  for await (const e of runSession(request, deps)) events.push(e);
  return events;
}

/** A real five-blink apply on the simulated car; returns its record, as exported to a file and loaded back. */
async function applied(mask?: string) {
  const records = new Map<string, BackupRecord>();
  let n = 0;
  const link = new SimulatedCar({
    parts: { '70E': '2Q0937089D' },
    values: { [KEY]: '3A00000000' },
    sleep: async () => {},
  });
  const deps: CodingDeps = {
    link,
    signal: new AbortController().signal,
    sleep: async () => {},
    readbackDelayMs: 0,
    newId: () => `trusted-mask-${++n}`,
    backups: {
      save: async (b) => void records.set(b.id, structuredClone(b)),
      update: async (id, patch) => {
        const cur = records.get(id);
        if (cur) records.set(id, { ...cur, ...patch });
      },
    },
  };
  await collect(
    { kind: 'apply', car: CAR, feature: BLINKS as NonNullable<typeof BLINKS>, settingId: 'value-5' },
    deps,
  );
  const made = records.get('trusted-mask-1');
  if (!made) throw new Error('fixture');
  expect(made.ownedMask).toBe('1600000000');
  const backup = parseBackupFile(JSON.stringify(mask === undefined ? made : { ...made, ownedMask: mask }));
  return { link, deps, backup, writesBefore: link.writes.length };
}

const reason = (events: CodingEvent[]) =>
  events.find((e) => e.type === 'refused')?.type === 'refused'
    ? (events.find((e) => e.type === 'refused') as Extract<CodingEvent, { type: 'refused' }>).reason
    : undefined;
const outcome = (events: CodingEvent[]) =>
  (events.at(-1) as Extract<CodingEvent, { type: 'outcome' }>).outcome;

const MASKS = [
  ['correct', '1600000000'],
  ['zero', '0000000000'],
  ['partial', '1000000000'],
  ['shifted', '0016000000'],
] as const;
const TAMPERED = MASKS.filter(([name]) => name !== 'correct');

describe("restore uses the trusted recipe mask, never the record's", () => {
  it.each(MASKS)(
    '%s mask: refuses to overwrite a later blink-count change (restore-conflict)',
    async (_n, mask) => {
      const { link, deps, backup, writesBefore } = await applied(mask);
      link.values.set(KEY, '3C00000000');
      const events = await collect({ kind: 'restore', backup }, deps);
      expect(reason(events)).toBe('restore-conflict');
      expect(link.writes).toHaveLength(writesBefore);
    },
  );

  it('correct mask, car unchanged: restores', async () => {
    const { link, deps, backup } = await applied();
    expect(outcome(await collect({ kind: 'restore', backup }, deps))).toBe('verified');
    expect(link.values.get(KEY)).toBe('3A00000000');
  });

  it.each(TAMPERED)(
    '%s mask, car unchanged: refuses the record as inconsistent, writes nothing',
    async (_n, mask) => {
      const { link, deps, backup, writesBefore } = await applied(mask);
      const events = await collect({ kind: 'restore', backup }, deps);
      expect(reason(events)).toBe('backup-inconsistent');
      expect(link.writes).toHaveLength(writesBefore);
    },
  );
});

describe("recheck uses the trusted recipe mask, or exact bytes — never the record's mask", () => {
  it.each(MASKS)('%s mask: a different blink count is a mismatch', async (_n, mask) => {
    const { link, deps, backup } = await applied(mask);
    link.values.set(KEY, '3C00000000');
    expect(outcome(await collect({ kind: 'recheck', backup }, deps))).toBe('mismatch');
  });

  it.each(TAMPERED)(
    '%s mask: judged on the exact bytes (confirms only the exact intended value)',
    async (_n, mask) => {
      const { link, deps, backup } = await applied(mask);
      expect(outcome(await collect({ kind: 'recheck', backup }, deps))).toBe('observed-match');
      link.values.set(KEY, '3E00000001');
      expect(outcome(await collect({ kind: 'recheck', backup }, deps))).toBe('mismatch');
    },
  );
});
