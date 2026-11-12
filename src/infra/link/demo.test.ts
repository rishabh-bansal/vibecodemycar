import { describe, expect, it } from 'vitest';
import type { BackupRecord } from '../../domain/backups/schema.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import { findFeature, settingsOf } from '../../domain/catalog/features.ts';
import type { CarSelection, FeatureItem } from '../../domain/catalog/types.ts';
import { buildApplyPlan, crc32Trailer } from '../../domain/coding/plan.ts';
import { createDemoCar, createDemoCarFromBackup, seedBlock } from './demo.ts';
import type { SimulatedCar } from './simulator.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const instant = async () => {};

describe('createDemoCar', () => {
  it('replays the real module part and the real before-bytes for a proven feature', async () => {
    const feature = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
    if (!feature) throw new Error('fixture');
    const car = createDemoCar(feature, 'value-5', { sleep: instant, latencyMs: 0, pendingMs: 0 });
    expect(await car.readDid({ request: '70E', response: '778' }, '0A5E')).toEqual({
      kind: 'ok',
      bytes: '3A00000000',
    });
    const part = await car.readDid({ request: '70E', response: '778' }, 'F187');
    expect(part.kind === 'ok' && Buffer.from(part.bytes, 'hex').toString()).toBe('2Q0937089D');
  });

  it('seeds a changeable value for features without a recorded session', () => {
    const recipe = APP_DATA.recipes['live-instrument-cluster-needle-sweep'];
    if (!recipe) throw new Error('fixture');
    for (const target of ['enabled', 'disabled']) {
      const before = seedBlock(recipe, target);
      expect(buildApplyPlan(recipe, target, before).noop).toBe(false);
    }
  });
});

describe('demo car — edge cases', () => {
  it('an experimental feature of a proven recipe runs end to end in demo mode (presents a proven part)', async () => {
    const analogue: CarSelection = { ...CAR, cluster: 'analogue' };
    const feature = findFeature(analogue, 'comfort-lane-change-indicator-5-flashes');
    if (feature?.tier !== 'experimental') throw new Error('fixture: experimental here');
    const car = createDemoCar(feature, 'value-5', { sleep: instant, latencyMs: 0, pendingMs: 0 });
    const events = [];
    const { runSession } = await import('../../domain/coding/run.ts');
    for await (const e of runSession(
      { kind: 'apply', car: analogue, feature, settingId: 'value-5' },
      {
        link: car,
        signal: new AbortController().signal,
        sleep: instant,
        readbackDelayMs: 0,
        backups: { save: async () => {}, update: async () => {} },
      },
    ))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'outcome', outcome: 'verified' });
  });

  it('seeds a block long enough for a field far into it', () => {
    const recipe = APP_DATA.recipes['live-instrument-cluster-needle-sweep'];
    if (!recipe?.field) throw new Error('fixture');
    const far = { ...recipe, field: { ...recipe.field, byteOffset: 9 } };
    expect(seedBlock(far, 'enabled')).toHaveLength(20);
  });

  it('never leaves a hole when the proven byte lies beyond the recorded read-back', async () => {
    const feature = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
    if (!feature?.proof) throw new Error('fixture');
    const proof = { ...feature.proof, readback: '3E00', recipe: { ...feature.proof.recipe, byte: 3 } };
    const car = createDemoCar({ ...feature, proof }, 'value-5', {
      sleep: instant,
      latencyMs: 0,
      pendingMs: 0,
    });
    expect(await car.readDid({ request: '70E', response: '778' }, '0A5E')).toEqual({
      kind: 'ok',
      bytes: '0000003A',
    });
  });
});

describe('demo fixtures for every recipe kind (C3.6)', () => {
  const run = async (
    req: import('../../domain/coding/types.ts').CodingRequest,
    link: SimulatedCar,
    offered?: FeatureItem,
  ) => {
    const { runSession } = await import('../../domain/coding/run.ts');
    const saved: BackupRecord[] = [];
    const events = [];
    for await (const e of runSession(req, {
      link,
      signal: new AbortController().signal,
      sleep: instant,
      readbackDelayMs: 0,
      backups: {
        save: async (b) => void saved.push(structuredClone(b)),
        update: async (id, patch) => {
          const i = saved.findIndex((b) => b.id === id);
          if (i >= 0) saved[i] = { ...(saved[i] as BackupRecord), ...patch };
        },
      },
      ...(offered ? { featureFor: () => offered } : {}),
    }))
      events.push(e);
    return { outcome: events.at(-1), record: saved[0] };
  };
  const quick = { sleep: instant, latencyMs: 0, pendingMs: 0 };

  it('scalar with a CRC trailer (VIM MIB3): a real-length block with a valid trailer, applied and restored', async () => {
    const feature = findFeature(CAR, 'video-in-motion-through-pen-drive');
    const recipe = APP_DATA.recipes['csmqb-vim-mib3-speed-threshold'];
    if (!feature?.recipeId || !recipe) throw new Error('fixture');
    const seed = seedBlock(recipe, 'always-on');
    expect(seed).toHaveLength(68);
    expect(seed.slice(60)).toBe(crc32Trailer(seed.slice(0, 60)));
    expect(seed.slice(8, 10)).not.toBe('FF');

    const applied = await run(
      { kind: 'apply', car: CAR, feature, settingId: 'always-on' },
      createDemoCar(feature, 'always-on', quick),
    );
    expect(applied.outcome).toMatchObject({ outcome: 'verified' });
    const backup = applied.record as BackupRecord;
    const restored = await run({ kind: 'restore', backup }, createDemoCarFromBackup(backup, quick));
    expect(restored.outcome).toMatchObject({ outcome: 'verified' });
  });

  it('dataset (MIB3 sound preset): another preset as the current block; applied and restored through its sequence', async () => {
    const recipe = APP_DATA.recipes['csmqb-mib3-sound-signature'];
    const preset = recipe?.choices?.[0];
    if (!recipe || !preset?.payload) throw new Error('fixture');
    // Not qualified, so the catalogue does not offer it; the demo can still simulate it for this test.
    const feature: FeatureItem = {
      id: 'beats-audio',
      name: recipe.name,
      tier: 'experimental',
      statusLabel: 'EXPERIMENTAL',
      recipeId: recipe.id,
      settings: settingsOf(recipe),
    };
    const seed = seedBlock(recipe, preset.id);
    expect(seed).toHaveLength(preset.payload.length);
    expect(seed).not.toBe(preset.payload);

    const car = createDemoCar(feature, preset.id, quick);
    const applied = await run({ kind: 'apply', car: CAR, feature, settingId: preset.id }, car, feature);
    expect(applied.outcome).toMatchObject({ outcome: 'verified' });
    expect(car.commands).toContain('1040'); // ran through the recipe's declared sequence
    const backup = applied.record as BackupRecord;
    const restored = await run({ kind: 'restore', backup }, createDemoCarFromBackup(backup, quick), feature);
    expect(restored.outcome).toMatchObject({ outcome: 'verified' });
  });
});
