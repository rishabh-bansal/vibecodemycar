/**
 * Independent review 2026-10-25, R2: only a recorded observation for the exact write is module behaviour.
 */
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { findFeature } from '../catalog/features.ts';
import type { Recipe } from '../catalog/schema.ts';
import { KNOWN_READBACKS, knownReadbacksFor } from './known-readbacks.ts';
import { buildApplyPlan, compareReadback, recipeDigest } from './plan.ts';
import { type CodingDeps, runSession } from './run.ts';
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
const KEY = '70E:0A5E';

async function apply(stores: string, opts: { recipeFor?: CodingDeps['recipeFor'] } = {}) {
  const records = new Map<string, BackupRecord>();
  const link = new SimulatedCar({
    parts: { '70E': '2Q0937089D' },
    values: { [KEY]: '3A00000000' },
    write: { kind: 'ack-stores', bytes: stores },
    sleep: async () => {},
  });
  const deps: CodingDeps = {
    link,
    signal: new AbortController().signal,
    sleep: async () => {},
    readbackDelayMs: 0,
    newId: () => 'known-1',
    ...(opts.recipeFor ? { recipeFor: opts.recipeFor } : {}),
    backups: { save: async (b) => void records.set(b.id, b), update: async () => {} },
  };
  const events: CodingEvent[] = [];
  for await (const e of runSession(
    { kind: 'apply', car: CAR, feature: BLINKS as NonNullable<typeof BLINKS>, settingId: 'value-5' },
    deps,
  ))
    events.push(e);
  return events.at(-1) as Extract<CodingEvent, { type: 'outcome' }>;
}

describe('the recorded observations themselves', () => {
  it.each(KNOWN_READBACKS.map((k) => [k.recipeId, k] as const))(
    '%s matches the current recipe revision and its live proof',
    async (_id, k) => {
      const recipe = APP_DATA.recipes[k.recipeId];
      if (!recipe) throw new Error(`recipe ${k.recipeId} missing`);
      // A changed recipe definition is not covered by an observation made with the old one: requalify.
      expect(await recipeDigest(recipe)).toBe(k.recipeDigest);
      const proofs = Object.values(APP_DATA.features).flatMap((f) =>
        f.recipeId === k.recipeId ? f.liveProof : [],
      );
      expect(proofs).toContainEqual(
        expect.objectContaining({
          module: expect.objectContaining({ part: k.module.part }),
          readback: k.observed,
        }),
      );
      // It must differ only outside the recipe's bytes; otherwise it would not be a module-side change.
      const plan = buildApplyPlan(recipe, 'value-5', '3A00000000');
      expect(plan.after).toBe(k.intended);
      expect(compareReadback({ ...plan, known: [k.observed] }, k.observed).kind).toBe('owned-match');
    },
  );
});

describe('a write is verified with module-managed bytes only for its exact recorded observation', () => {
  it('the five-blink write on BCM 2Q0937089D reading back 3E00A00000 is verified, with the change shown', async () => {
    expect(await apply('3E00A00000')).toMatchObject({
      outcome: 'verified',
      phase: expect.stringMatching(/also changed something.*don't know yet.*flagged it for review/),
    });
  });

  it('other bytes changed (3EDEADBEEF): a mismatch that names the unexplained bytes', async () => {
    expect(await apply('3EDEADBEEF')).toMatchObject({
      outcome: 'mismatch',
      phase: expect.stringContaining('also changed something else we have no record of'),
    });
  });

  it('the same A0 under another recipe revision is not covered', async () => {
    const original = APP_DATA.recipes['live-bcm-polite-blinks'] as Recipe;
    const revised: Recipe = { ...original, name: `${original.name} (revised)` };
    expect(
      await apply('3E00A00000', { recipeFor: (id) => (id === original.id ? revised : APP_DATA.recipes[id]) }),
    ).toMatchObject({
      outcome: 'mismatch',
    });
  });

  it('applies to the exact block written only', () => {
    const base = {
      recipeId: 'live-bcm-polite-blinks',
      recipeDigest: KNOWN_READBACKS[0]?.recipeDigest ?? '',
      module: { request: '70E', response: '778' },
      part: '2Q0937089D',
      did: '0A5E',
    };
    expect(knownReadbacksFor({ ...base, intended: '3E00000000' })).toEqual(['3E00A00000']);
    expect(knownReadbacksFor({ ...base, intended: '3C00000000' })).toEqual([]);
    expect(knownReadbacksFor({ ...base, did: '0A5F', intended: '3E00000000' })).toEqual([]);
    // Another part number (e.g. a car where the recipe runs as "experimental" with no required part).
    expect(knownReadbacksFor({ ...base, part: '2Q0937089C', intended: '3E00000000' })).toEqual([]);
  });
});
