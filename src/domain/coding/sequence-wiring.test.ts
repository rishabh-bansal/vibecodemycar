import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { settingsOf } from '../catalog/features.ts';
import type { Recipe } from '../catalog/schema.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { buildApplyPlan } from './plan.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { BackupStore, CodingEvent } from './types.ts';

/**
 * C1: a dataset recipe's declared sequence is carried from the source bank, through the generated runtime file
 * and the plan, to the link's sequence writer — and nothing else ever writes it.
 */

const SOUND = 'csmqb-mib3-sound-signature';
const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const source = JSON.parse(
  readFileSync(new URL('../../../data/source/feature-recipes.json', import.meta.url), 'utf8'),
).recipes as Record<string, Recipe>;
const bundled = APP_DATA.recipes[SOUND] as Recipe;
const preset = bundled.choices?.[0];
if (!preset?.payload) throw new Error('fixture: the bundled preset has no payload');
const BEFORE = 'AB'.repeat(preset.payload.length / 2);
const PRESET_ID = preset.id;

const offer = (recipe: Recipe): FeatureItem => ({
  id: 'beats-audio',
  name: recipe.name,
  tier: 'experimental',
  statusLabel: 'EXPERIMENTAL',
  recipeId: recipe.id,
  settings: settingsOf(recipe),
});

class Memory implements BackupStore {
  records = new Map<string, BackupRecord>();
  async save(b: BackupRecord) {
    this.records.set(b.id, b);
  }
  async update(id: string, patch: Parameters<BackupStore['update']>[1]) {
    const cur = this.records.get(id);
    if (cur) this.records.set(id, { ...cur, ...patch });
  }
}

function session(recipe: Recipe, link: SimulatedCar, extra: Partial<CodingDeps> = {}) {
  let t = 0;
  const now = () => new Date(Date.UTC(2026, 9, 25, 12, 0, 0, t++));
  const backups = new Memory();
  const deps: CodingDeps = {
    link,
    backups,
    signal: new AbortController().signal,
    now,
    sleep: async () => {},
    readbackDelayMs: 0,
    recipeFor: (id) => (id === recipe.id ? recipe : APP_DATA.recipes[id]),
    featureFor: () => offer(recipe),
    ...extra,
  };
  return { deps, backups, now };
}
const car = (now?: () => Date, mode: 'demo' | 'live' = 'demo') =>
  new SimulatedCar({
    parts: { '773': '3G5035816A' },
    values: { '773:7201': BEFORE },
    mode,
    ...(now ? { now } : {}),
  });

async function run(recipe: Recipe, deps: CodingDeps): Promise<CodingEvent[]> {
  const out: CodingEvent[] = [];
  for await (const e of runSession(
    { kind: 'apply', car: CAR, feature: offer(recipe), settingId: PRESET_ID },
    deps,
  ))
    out.push(e);
  return out;
}

describe('source → generated runtime → plan → domain routing (C1)', () => {
  it('the generated recipe carries exactly the source sequence', () => {
    expect(source[SOUND]?.sequence).toBeDefined();
    expect(bundled.sequence).toEqual(source[SOUND]?.sequence);
  });

  it('the plan built from the bundled recipe carries it', () => {
    const plan = buildApplyPlan(bundled, preset.id, BEFORE);
    expect(plan.sequence?.pre).toContain('1040');
    expect(plan.sequence).toEqual(bundled.sequence);
  });

  it('the session routes it to the link sequence writer with the recipe ritual, never to writeDid', async () => {
    const holder: { now?: () => Date } = {};
    const link = car(() => holder.now?.() ?? new Date());
    const s = session(bundled, link);
    holder.now = s.now;
    const generic = vi.spyOn(link, 'writeDid');
    const sequence = vi.spyOn(link, 'sequence');
    const events = await run(bundled, s.deps);
    expect(events.find((e) => e.type === 'outcome')).toMatchObject({ outcome: 'verified' });
    expect(generic).not.toHaveBeenCalled();
    expect(sequence).toHaveBeenCalledTimes(1);
    expect(sequence.mock.calls[0]?.[1]).toMatchObject({
      pre: bundled.sequence?.pre,
      post: bundled.sequence?.post,
      write: { kind: 'did', did: '7201', bytes: preset.payload },
    });
  });

  it('a dataset without a declared sequence is written verbatim through the standard writer', async () => {
    const { sequence: _lost, ...bare } = bundled;
    const holder: { now?: () => Date } = {};
    const link = car(() => holder.now?.() ?? new Date());
    const s = session(bare, link);
    holder.now = s.now;
    const generic = vi.spyOn(link, 'writeDid');
    const sequence = vi.spyOn(link, 'sequence');
    const events = await run(bare, s.deps);
    expect(events.find((e) => e.type === 'outcome')).toMatchObject({ outcome: 'verified' });
    expect(generic).toHaveBeenCalledTimes(1);
    expect(generic.mock.calls[0]?.[2]).toBe(preset.payload);
    expect(sequence).not.toHaveBeenCalled();
  });

  it('a link that cannot run sequences refuses before the car is touched', async () => {
    const link = car();
    Object.defineProperty(link, 'sequence', { value: undefined });
    const s = session(bundled, link);
    const generic = vi.spyOn(link, 'writeDid');
    const events = await run(bundled, s.deps);
    expect(events.find((e) => e.type === 'refused')).toMatchObject({ reason: 'not-eligible' });
    expect(generic).not.toHaveBeenCalled();
    expect(link.readinessReads).toBe(0);
  });
});

describe('declared sequences run on a real car (no qualification switch)', () => {
  it('a live link runs the dataset ritual with a durable backup first', async () => {
    const holder: { now?: () => Date } = {};
    const link = car(() => holder.now?.() ?? new Date(), 'live');
    const s = session(bundled, link);
    holder.now = s.now;
    const sequence = vi.spyOn(link, 'sequence');
    const events = await run(bundled, s.deps);
    expect(events.find((e) => e.type === 'refused')).toBeUndefined();
    expect(events.find((e) => e.type === 'outcome')).toMatchObject({ outcome: 'verified' });
    expect(sequence).toHaveBeenCalledTimes(1);
    expect(s.backups.records.size).toBe(1);
  });
});
