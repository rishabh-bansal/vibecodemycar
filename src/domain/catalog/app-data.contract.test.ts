import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { digestAccepted, recipeDigest } from '../coding/plan.ts';
import type { CodingRecipe } from '../coding/types.ts';
import { APP_DATA, platformKeyOf, recipeIdFor } from './data.ts';
import type { Recipe, RecipeVariant, StepRecipe } from './types.ts';

/**
 * What scripts/build-data.mjs promises the runtime (the data contract): executable is derived from structure only
 * (a recipe is non-executable only when it has no bytes to write), groups ship their steps, every write target
 * carries a password, and every catalogue slug is a feature.
 */
const recipes = Object.values(APP_DATA.recipes);

/** Every write target: top-level recipes, group steps and the variants of both. */
function targets(r: Recipe): (StepRecipe | RecipeVariant)[] {
  const steps: StepRecipe[] = r.kind === 'group' ? r.steps : [r];
  return steps.flatMap((s): (StepRecipe | RecipeVariant)[] => (s.kind === 'alt' ? [s, ...s.variants] : [s]));
}

function hasBytes(t: StepRecipe | RecipeVariant): boolean {
  switch (t.kind) {
    case 'field':
      return t.choices.length > 0;
    case 'scalar':
      return true;
    case 'ops':
      return t.choices.some((c) => c.ops.length > 0);
    case 'dataset':
      return t.choices.some((c) => !!c.payload);
    case 'alt':
      return t.variants.some(hasBytes);
  }
}

describe('generated recipes', () => {
  it('ships recipes of every runtime shape', () => {
    const kinds = new Set(recipes.map((r) => r.kind));
    for (const k of ['field', 'scalar', 'alt', 'group', 'dataset'] as const) expect(kinds).toContain(k);
  });

  it.each(recipes.map((r) => [r.id, r] as const))('%s: executable only from structure', (_id, r) => {
    const runnable = r.kind === 'group' ? r.steps.every(hasBytes) : hasBytes(r);
    if (runnable) {
      expect(r.executable).toBeUndefined();
      expect(r.reason).toBeUndefined();
    } else {
      expect(r.executable).toBe(false);
      expect(r.reason).toBe('no-bytes');
    }
    expect(r).not.toHaveProperty('protectedSafety');
  });

  it('groups have no top-level encoding and ship every step', () => {
    const groups = recipes.filter((r) => r.kind === 'group');
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.did).toBeUndefined();
      expect(g.field).toBeUndefined();
      expect(g.variants).toBeUndefined();
      expect(g.steps.length).toBeGreaterThan(0);
      for (const s of g.steps)
        expect(s.requestId === null || /^[0-7][0-9A-F]{2}$/.test(s.requestId)).toBe(true);
    }
  });

  it('every write target with a module carries a password and says where it came from', () => {
    for (const r of recipes) {
      for (const t of targets(r)) {
        const unit = 'unit' in t ? t.unit : 'x';
        if (!unit) continue;
        expect(t.password, `${r.id}`).toMatch(/^\d+$/);
        expect(['recipe', 'unit-default']).toContain(t.passwordSource);
      }
    }
  });

  it('BCM-generation selectors carry the matching flag', () => {
    for (const r of recipes) {
      for (const t of targets(r)) {
        if (!('selector' in t)) continue;
        if (t.selector === 'new-bcm') expect(t.requiresNewBcm).toBe(true);
        if (t.selector === 'old-bcm') expect(t.requiresNewBcm).toBe(false);
      }
    }
  });
});

describe('generated features', () => {
  const catalogue = JSON.parse(
    readFileSync(new URL('../../data/catalogue.json', import.meta.url), 'utf8'),
  ) as {
    models: { features: { slug: string }[] }[];
  };
  const slugs = new Set(catalogue.models.flatMap((m) => m.features.map((f) => f.slug)));

  it('has a feature for every catalogue slug, keyed by the slug', () => {
    for (const slug of slugs) {
      expect(APP_DATA.features[slug]?.source, slug).toBe('catalogue');
    }
  });

  it('keeps the legacy matrix features so existing backups still resolve', () => {
    expect(Object.values(APP_DATA.features).filter((f) => f.source === 'matrix')).toHaveLength(59);
  });

  it('resolves a recipe per platform', () => {
    expect(platformKeyOf('MQB-A0-IN')).toBe('MQB-A0-IN');
    expect(platformKeyOf('MQB-37')).toBe('MQB');
    expect(platformKeyOf(null)).toBeNull();
    for (const f of Object.values(APP_DATA.features)) {
      for (const id of Object.values(f.recipeByPlatform))
        expect(APP_DATA.recipes[id], `${f.id} → ${id}`).toBeDefined();
      if (f.recipeId) expect(recipeIdFor(f, null)).toBe(f.recipeId);
    }
  });
});

describe('backups made with earlier definitions', () => {
  // Recipes whose 26c9b50 definition wrote nothing (kind 'block' / no bytes) or writes different bits now:
  // no restorable backup of the old definition can exist, or restoring it would be wrong.
  const REDEFINED = new Set([
    'csmqb-dynamic-turn-lights-tiguan2-fl',
    'csmqb-mqb-09-sound-confirmation-of-lock-and-unlock',
    'csmqb-mqb-5-f-eco-driving',
    'group:ambient-light-color-selection30-colors-dashboard-and-multimedia-system',
    'group:comfort-entry-driver-seat',
    'group:comfort-entry-passenger-seat',
    'group:corner-function-activation',
    'group:display-start-stop-information-in-mmi',
    'group:front-fog-lights-activate-with-high-beam',
    'group:rear-side-lights-turn-on-when-daytime-running-lights-are-active-scandiavian-drls-name-skoda-kodiaq-etc',
    'group:show-offroad-screen-in-multimedia-system',
    'group:teardrop-mode-additional-wipers-pass-on-the-windshield',
  ]);
  const legacy = JSON.parse(readFileSync('data/source/legacy/recipes-26c9b50.json', 'utf8')) as {
    recipes: Record<string, CodingRecipe>;
  };

  it('still accepts the digest of every byte-identical 26c9b50 recipe', async () => {
    const ids = Object.keys(legacy.recipes).filter((id) => !REDEFINED.has(id));
    expect(ids.length).toBeGreaterThanOrEqual(24);
    for (const id of ids) {
      const now = APP_DATA.recipes[id] as CodingRecipe | undefined;
      expect(now, id).toBeDefined();
      const old = await recipeDigest(legacy.recipes[id] as CodingRecipe);
      expect(await digestAccepted(now as CodingRecipe, old), id).toBe(true);
    }
  });

  it('does not accept an unrelated digest', async () => {
    const now = APP_DATA.recipes['csadapt-10073'] as CodingRecipe;
    expect(await digestAccepted(now, '0'.repeat(64))).toBe(false);
    expect(await digestAccepted(now, await recipeDigest(now))).toBe(true);
  });
});

describe('feature copy', () => {
  const features = Object.values(APP_DATA.features);
  const codable = features.filter((f) =>
    Object.values(f.recipeByPlatform).some((id) => APP_DATA.recipes[id]?.executable !== false),
  );

  /** Setting ids a feature offers: its display settings, else every choice of every recipe it runs. */
  function offered(f: (typeof features)[number]): Set<string> {
    if (f.settings) return new Set(f.settings.map((s) => s.id));
    const ids = new Set<string>();
    for (const id of new Set(Object.values(f.recipeByPlatform))) {
      const r = APP_DATA.recipes[id] as Recipe;
      for (const c of 'choices' in r && r.choices ? r.choices : []) ids.add(c.id);
      if (r.kind === 'alt') for (const v of r.variants) for (const c of v.choices ?? []) ids.add(c.id);
    }
    return ids;
  }

  const WORDING = /\b(experimental|tested|testing|demo|beta)\b/i;
  const VENDOR = /\b(MQB_|csmqb-|csadapt-|group:|RES:|codingDB)/;

  it('covers every codable catalogue slug and legacy feature', () => {
    expect(codable.filter((f) => f.source === 'catalogue')).toHaveLength(112);
    for (const f of codable) {
      expect(f.displayName, f.id).toBeTruthy();
      expect(f.description, f.id).toBeTruthy();
      expect(f.settingLabels, f.id).toBeDefined();
    }
  });

  it.each(codable.map((f) => [f.id, f] as const))('%s: plain wording and a label per setting', (_id, f) => {
    const name = f.displayName ?? '';
    const description = f.description ?? '';
    const labels = f.settingLabels ?? {};
    expect(name).toMatch(/^[A-Z0-9]/);
    expect(name).not.toMatch(VENDOR);
    expect(description).toMatch(/[.]$/);
    expect(description.split(/[.!?](?:\s|$)/).filter(Boolean).length).toBeLessThanOrEqual(2);
    for (const text of [name, description, ...Object.values(labels)]) {
      expect(text).not.toMatch(WORDING);
      expect(text).not.toMatch(VENDOR);
    }
    expect(Object.keys(labels).sort()).toEqual([...offered(f)].sort());
    for (const label of Object.values(labels)) {
      expect(label).not.toMatch(/^(enabled|disabled|ENABLE|DISABLE|value-\w+)$/);
    }
    for (const s of f.settings ?? []) expect(s.label).toBe(labels[s.id]);
  });
});
