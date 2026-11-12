import { describe, expect, it } from 'vitest';
import { clusterRequirement } from './cluster.ts';
import { APP_DATA } from './data.ts';
import {
  clusterMismatch,
  featureDescription,
  featureDisplayName,
  featureSettingLabel,
  featuresFor,
  findFeature,
  isLocked,
  parseFreeValue,
  platformsFor,
  recipeIdFor,
  scalarOf,
  settingsOf,
  unlockableCount,
} from './features.ts';
import { familyModels, familyOf, familyOfBcmPart, listedInFamily, listedModels } from './platform.ts';
import type { Recipe } from './schema.ts';
import { withDetected } from './selection.ts';
import { type CarSelection, type Cluster, OTHER_MODEL, OTHER_VARIANT } from './types.ts';
import { clusterOf, defaultSelection, periodsOf } from './vehicles.ts';

const kushaqMonteCarlo = (over: Partial<CarSelection> = {}): CarSelection => ({
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
  ...over,
});

describe('featuresFor — the live-verified car', () => {
  it('never shows testing language: every codable feature reads the same, whatever its internal tier', () => {
    for (const item of featuresFor(kushaqMonteCarlo()))
      expect(item.statusLabel).toBe(
        item.tier === 'unavailable'
          ? 'NOT AVAILABLE FOR YOUR CAR'
          : item.needsCluster
            ? 'DEPENDS ON YOUR INSTRUMENT CLUSTER'
            : 'AVAILABLE FOR YOUR CAR',
      );
  });

  const items = () => featuresFor(kushaqMonteCarlo());
  const get = (id: string) => items().find((f) => f.id === id);

  it('marks the live-proven feature as tested, with its proof attached', () => {
    const blinks = get('comfort-lane-change-indicator-5-flashes');
    expect(blinks?.tier).toBe('tested');
    expect(blinks?.statusLabel).toBe('AVAILABLE FOR YOUR CAR');
    expect(blinks?.proof?.module.part).toBe('2Q0937089D');
    expect(blinks?.settings.map((s) => s.label)).toEqual(['2 blinks', '3 blinks', '4 blinks', '5 blinks']);
  });

  it('offers the live-proven speed warning like any other feature — no safety lock', () => {
    const chime = get('80kmph-and-120kmph-speed-chime-warning');
    expect(chime?.tier).toBe('tested');
    expect(chime?.settings.map((s) => s.id).sort()).toEqual(['disabled', 'enabled']);
  });

  it('offers the needle sweep on a digital cluster with the same plain label as any feature', () => {
    const needle = get('instrument-cluster-needle-sweep');
    expect(needle?.tier).not.toBe('unavailable');
    expect(needle?.statusLabel).toBe('AVAILABLE FOR YOUR CAR');
  });

  it('ships no heuristic matches — only manual mappings reach the bundle', () => {
    expect(Object.values(APP_DATA.features).some((f) => f.matchConfidence === 'heuristic')).toBe(false);
  });

  it('calls a feature "not available" only when its recipe has no bytes to write', () => {
    for (const item of items()) {
      if (item.reason !== 'not-executable') continue;
      const recipe = item.recipeId ? APP_DATA.recipes[item.recipeId] : undefined;
      const id = recipeIdFor(APP_DATA.features[item.id] as never, kushaqMonteCarlo());
      const resolved = id ? APP_DATA.recipes[id] : recipe;
      expect(resolved && isLocked(resolved)).toBe(true);
      expect(item.statusLabel).toBe('NOT AVAILABLE FOR YOUR CAR');
    }
  });

  it('keeps variant-resolvable recipes experimental — the selector settles at write time', () => {
    const item = get('anti-theft-alarm');
    if (item) expect(item.tier).toBe('experimental');
  });

  it('never offers a feature with no recipe for this platform', () => {
    for (const item of items()) {
      const f = APP_DATA.features[item.id];
      if (f && !recipeIdFor(f, kushaqMonteCarlo()))
        expect(item).toMatchObject({ tier: 'unavailable', reason: 'not-mapped' });
    }
  });

  it('orders tested → experimental → unavailable', () => {
    const rank = { tested: 0, experimental: 1, unavailable: 2 } as const;
    const ranks = items().map((f) => rank[f.tier]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('featuresFor — proof binding', () => {
  it('does not carry the pre-April-2024 proof to a later build of the same variant', () => {
    // Still offered (it is listed for the model), but never "tested" on a build the proof is not bound to.
    const later = findFeature(kushaqMonteCarlo({ year: 2025 }), 'comfort-lane-change-indicator-5-flashes');
    expect(later?.tier).not.toBe('tested');
    expect(later?.proof).toBeUndefined();
  });

  it('does not guess the period for 2024, and binds once the user says which', () => {
    const feature = 'comfort-lane-change-indicator-5-flashes';
    expect(findFeature(kushaqMonteCarlo({ year: 2024 }), feature)?.tier).toBe('experimental');
    expect(findFeature(kushaqMonteCarlo({ year: 2024, period2024: 'pre-2024-04' }), feature)?.tier).toBe(
      'tested',
    );
  });

  it('does not carry the proof to a different cluster type', () => {
    expect(
      findFeature(kushaqMonteCarlo({ cluster: 'analogue' }), 'comfort-lane-change-indicator-5-flashes')?.tier,
    ).toBe('experimental');
  });

  it('never reports "tested" without a proof bound to that exact variant, across every car', () => {
    const years = [2022, 2024, 2025];
    for (const v of APP_DATA.vehicles) {
      for (const year of years) {
        for (const cluster of ['analogue', 'digital'] as Cluster[]) {
          const sel: CarSelection = { brand: v.brand, model: v.model, variant: v.variant, year, cluster };
          for (const f of featuresFor(sel).filter((x) => x.tier === 'tested')) {
            expect(f.proof, `${v.model} ${v.variant} ${year} ${f.id}`).toBeDefined();
            expect(f.proof?.vehicle.variant).toBe(v.variant);
            expect(f.proof?.vehicle.model).toBe(v.model);
          }
        }
      }
    }
  });

  it('every offered feature has a recipe with bytes, and something to pick', () => {
    for (const v of APP_DATA.vehicles) {
      const cluster = clusterOf(v.mid) ?? 'analogue';
      const year = periodsOf(v).has('post-2024-04') ? 2025 : 2022;
      for (const f of featuresFor({ brand: v.brand, model: v.model, variant: v.variant, year, cluster })) {
        if (f.tier === 'unavailable') continue;
        const recipe = f.recipeId ? APP_DATA.recipes[f.recipeId] : undefined;
        expect(recipe, f.id).toBeDefined();
        expect(recipe && isLocked(recipe)).toBe(false);
        expect(f.settings.length > 0 || !!f.scalar, f.id).toBe(true);
      }
    }
  });
});

describe('featuresFor — unknown variants', () => {
  it("still offers the model's features, as experimental", () => {
    const items = featuresFor(kushaqMonteCarlo({ variant: OTHER_VARIANT }));
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((f) => f.tier === 'experimental')).toBe(true);
    expect(items.every((f) => f.tier !== 'tested')).toBe(true);
    expect(unlockableCount(items)).toBeGreaterThan(0);
  });

  it('treats a market-table variant with no catalogue evidence the same way', () => {
    const items = featuresFor(kushaqMonteCarlo({ variant: 'classic-plus', cluster: 'analogue' }));
    expect(unlockableCount(items)).toBeGreaterThan(0);
  });
});

describe('platform resolution', () => {
  it('maps India A0 models and the MQB models to the contract platform keys', () => {
    expect(platformsFor(kushaqMonteCarlo())[0]).toBe('MQB-A0-IN');
    expect(platformsFor({ brand: 'volkswagen', model: 'tiguan' })).toContain('MQB');
  });

  it("picks the recipe for the car's platform from a per-platform feature", () => {
    const f = Object.values(APP_DATA.features).find(
      (x) =>
        x.recipeByPlatform['MQB-A0-IN'] &&
        x.recipeByPlatform.MQB &&
        x.recipeByPlatform['MQB-A0-IN'] !== x.recipeByPlatform.MQB,
    );
    if (!f) return; // no split feature in this build of the data
    expect(recipeIdFor(f, kushaqMonteCarlo())).toBe(f.recipeByPlatform['MQB-A0-IN']);
    expect(
      recipeIdFor(f, {
        brand: 'volkswagen',
        model: 'tiguan',
        variant: 'r-line',
        year: 2024,
        cluster: 'digital',
      }),
    ).toBe(f.recipeByPlatform.MQB);
  });
});

describe('free values (scalar recipes)', () => {
  const recipe = {
    id: 't',
    name: 'Threshold',
    kind: 'scalar',
    unit: '17',
    requestId: '714',
    responseId: '77E',
    password: null,
    did: '050E',
    scalar: { byteOffset: 13, dataLength: 1, multiplier: 1, offset: -10, unit: '°C' },
  } as Recipe;

  it('derives the range from the byte width, multiplier and offset', () => {
    expect(scalarOf(recipe)).toEqual({ min: -10, max: 245, step: 1, unit: '°C' });
  });

  it('accepts value:<n> inside the range and on the step grid only', () => {
    const item = { scalar: scalarOf(recipe) };
    expect(parseFreeValue(item, 'value:4')).toBe(4);
    expect(parseFreeValue(item, 'value:-10')).toBe(-10);
    expect(parseFreeValue(item, 'value:246')).toBeUndefined();
    expect(parseFreeValue(item, 'value:4.5')).toBeUndefined();
    expect(parseFreeValue(item, 'value:abc')).toBeUndefined();
    expect(parseFreeValue({}, 'value:4')).toBeUndefined();
  });
});

describe('settingsOf', () => {
  it('labels toggles On/Off with On first', () => {
    const recipe = APP_DATA.recipes['live-instrument-cluster-needle-sweep'];
    expect(recipe).toBeDefined();
    if (!recipe) return;
    expect(settingsOf(recipe).map((s) => s.label)).toEqual(['On', 'Off']);
  });

  it('keeps the wire value untouched by the display label', () => {
    const recipe = APP_DATA.recipes['live-bcm-polite-blinks'];
    if (!recipe) throw new Error('fixture recipe missing');
    expect(settingsOf(recipe).map((s) => [s.label, s.value])).toEqual([
      ['2 blinks', 0],
      ['3 blinks', 1],
      ['4 blinks', 2],
      ['5 blinks', 3],
    ]);
  });
});

describe('settingsOf — every choice, no allowlist', () => {
  it('offers every choice the recipe declares', () => {
    for (const recipe of Object.values(APP_DATA.recipes)) {
      const declared = recipe.choices ?? recipe.variants?.find((v) => v.choices?.length)?.choices ?? [];
      expect(
        settingsOf(recipe)
          .map((s) => s.id)
          .sort(),
      ).toEqual(declared.map((c) => c.id).sort());
    }
  });

  it("uses the feature's own relabel/order when the catalogue map gives one", () => {
    const recipe = APP_DATA.recipes['live-instrument-cluster-needle-sweep'];
    if (!recipe) throw new Error('fixture recipe missing');
    expect(
      settingsOf(recipe, [
        { id: 'disabled', label: 'No sweep' },
        { id: 'enabled', label: 'Sweep' },
      ]).map((s) => s.label),
    ).toEqual(['No sweep', 'Sweep']);
  });
});

describe('friendly copy from the app data', () => {
  const car = kushaqMonteCarlo();
  const withCopy = Object.values(APP_DATA.features).find(
    (f) =>
      f.displayName && f.description && Object.keys(f.settingLabels ?? {}).length > 0 && f.listedOn.length,
  );

  it('prefers the friendly name, description and setting labels, and falls back where there are none', () => {
    if (!withCopy) throw new Error('no feature with friendly copy');
    expect(featureDisplayName(withCopy.id, 'fallback')).toBe(withCopy.displayName);
    expect(featureDescription(withCopy.id)).toBe(withCopy.description);
    const [choice, label] = Object.entries(withCopy.settingLabels ?? {})[0] ?? [];
    expect(featureSettingLabel(withCopy.id, choice ?? '')).toBe(label);
    expect(featureDisplayName('no-such-feature', 'Fallback name')).toBe('Fallback name');
    expect(featureDescription('no-such-feature')).toBeUndefined();
    expect(featureSettingLabel(withCopy.id, 'no-such-setting')).toBeUndefined();
  });

  it('lists features under their friendly names and setting labels', () => {
    const blinks = findFeature(car, 'comfort-lane-change-indicator-5-flashes');
    const record = APP_DATA.features['comfort-lane-change-indicator-5-flashes'];
    expect(blinks?.name).toBe(record?.displayName ?? record?.name);
    for (const s of blinks?.settings ?? []) {
      const friendly = record?.settingLabels?.[s.id];
      if (friendly) expect(s.label).toBe(friendly);
    }
  });

  it('still lists what this car can take first', () => {
    const tiers = featuresFor(car).map((f) => f.tier !== 'unavailable');
    expect(tiers.indexOf(false)).toBeGreaterThan(tiers.lastIndexOf(true));
  });
});

describe('featuresFor — brand and model decide what can be coded', () => {
  /**
   * Codable features per model. Sister cars of one platform family share their electrics, so every model of a
   * family offers the same set: MQB-A0-IN (Kushaq, Slavia, Kylaq, Taigun, Virtus) and MQB (Kodiaq, Octavia RS,
   * Superb, Tayron, Tiguan, Golf GTI). Before families, each model offered only what its own catalogue listed
   * (Kylaq 75, Slavia 71, Kushaq 57, Kodiaq 11, Virtus 100, Taigun 28, Tiguan 10, the rest 0).
   */
  const CODABLE: Record<string, number> = {
    'skoda-kylaq': 130,
    'skoda-slavia': 130,
    'skoda-kushaq': 130,
    'skoda-kodiaq': 25,
    'skoda-octavia-rs': 25,
    'skoda-superb': 25,
    'volkswagen-virtus': 130,
    'volkswagen-taigun': 130,
    'volkswagen-tayron': 25,
    'volkswagen-tiguan': 25,
    'volkswagen-golf-gti': 25,
  };
  const codable = (sel: CarSelection) =>
    featuresFor(sel)
      .filter((f) => f.tier !== 'unavailable')
      .map((f) => f.id)
      .sort();
  const models = [...new Set(APP_DATA.vehicles.map((v) => `${v.brand}|${v.model}`))].map((k) => {
    const [brand, model] = k.split('|') as [CarSelection['brand'], string];
    return { brand, model };
  });

  it.each(models)("$brand $model: its family's codable features", ({ brand, model }) => {
    const now = codable(defaultSelection(brand, model));
    expect(now.length).toBe(CODABLE[`${brand}-${model}`]);
    // …and the same set every variant, year and cluster an earlier saved selection may still name.
    for (const v of APP_DATA.vehicles.filter((x) => x.brand === brand && x.model === model)) {
      for (const cluster of ['analogue', 'digital'] as Cluster[]) {
        expect(codable({ brand, model, variant: v.variant, year: 2023, cluster })).toEqual(now);
      }
    }
  });

  it('every model of a family offers the same codable features', () => {
    for (const family of ['MQB-A0-IN', 'MQB'] as const) {
      const keys = familyModels(family);
      expect(keys.length).toBeGreaterThan(1);
      const sets = keys.map((key) => {
        const [brand, ...rest] = key.split('-') as [CarSelection['brand'], ...string[]];
        return codable(defaultSelection(brand, rest.join('-')));
      });
      for (const set of sets) expect(set).toEqual(sets[0]);
    }
  });

  it("offers on the Taigun a feature only the Kushaq's own catalogue lists, with the family's recipe", () => {
    const taigun = defaultSelection('volkswagen', 'taigun');
    const onlyKushaq = Object.values(APP_DATA.features).filter((f) => {
      const on = listedModels(f);
      return f.source === 'catalogue' && on.has('skoda-kushaq') && !on.has('volkswagen-taigun');
    });
    const codableOnKushaq = onlyKushaq.filter(
      (f) => findFeature(defaultSelection('skoda', 'kushaq'), f.id)?.tier !== 'unavailable',
    );
    expect(codableOnKushaq.length).toBeGreaterThan(0);
    for (const f of codableOnKushaq) {
      const item = findFeature(taigun, f.id);
      expect(item?.tier, f.id).not.toBe('unavailable');
      expect(item?.recipeId).toBe(f.recipeByPlatform['MQB-A0-IN']);
    }
  });

  it('keeps the families apart: an MQB-A0-IN-only feature is not offered on an MQB car', () => {
    const kodiaq = new Set(codable(defaultSelection('skoda', 'kodiaq')));
    const kushaq = codable(defaultSelection('skoda', 'kushaq'));
    expect(kushaq.some((id) => !kodiaq.has(id))).toBe(true);
    for (const id of kodiaq) {
      const f = APP_DATA.features[id];
      expect(f && (listedInFamily(f, 'MQB') || f.liveProof.length > 0), id).toBe(true);
    }
  });
});

describe('featuresFor — "Other model"', () => {
  const other = (brand: CarSelection['brand'] = 'skoda') => defaultSelection(brand, OTHER_MODEL);

  it("before connecting: the brand's most common family, to be confirmed on connect", () => {
    expect(familyOf(other())).toEqual({ family: 'MQB-A0-IN', confirmed: false });
    expect(codable(other())).toEqual(codable(defaultSelection('skoda', 'kushaq')));
    expect(codable(other('volkswagen'))).toEqual(codable(defaultSelection('volkswagen', 'virtus')));
  });

  it('after connecting: the family its body computer names', () => {
    const a0 = withDetected(other(), { bcmPart: '2Q0937089D', platform: familyOfBcmPart('2Q0937089D') });
    expect(familyOf(a0)).toEqual({ family: 'MQB-A0-IN', confirmed: true });
    expect(codable(a0)).toEqual(codable(defaultSelection('volkswagen', 'taigun')));
    const mqb = withDetected(other('volkswagen'), {
      bcmPart: '5Q0937084',
      platform: familyOfBcmPart('5Q0937084'),
    });
    expect(familyOf(mqb)).toEqual({ family: 'MQB', confirmed: true });
    expect(codable(mqb)).toEqual(codable(defaultSelection('skoda', 'kodiaq')));
  });

  it('an unknown body computer keeps the default family, unconfirmed', () => {
    const unknown = withDetected(other(), { bcmPart: '6R0937087' });
    expect(familyOf(unknown)).toEqual({ family: 'MQB-A0-IN', confirmed: false });
    expect(codable(unknown).length).toBeGreaterThan(0);
  });

  function codable(sel: CarSelection): string[] {
    return featuresFor(sel)
      .filter((f) => f.tier !== 'unavailable')
      .map((f) => f.id)
      .sort();
  }
});

describe('featuresFor — features that depend on the instrument cluster', () => {
  const slavia = defaultSelection('skoda', 'slavia');
  const needle = (sel: CarSelection) => findFeature(sel, 'instrument-cluster-needle-sweep');

  it('before connecting: still offered, marked as depending on the cluster', () => {
    expect(needle(slavia)).toMatchObject({
      tier: 'experimental',
      statusLabel: 'DEPENDS ON YOUR INSTRUMENT CLUSTER',
      needsCluster: 'analogue',
    });
  });

  it('after connecting: resolved by the cluster the car reported', () => {
    const analogue = withDetected(slavia, { cluster: 'analogue' });
    expect(needle(analogue)).toMatchObject({ statusLabel: 'AVAILABLE FOR YOUR CAR' });
    expect(needle(analogue)?.needsCluster).toBeUndefined();
    const digital = withDetected(slavia, { cluster: 'digital', clusterPart: '6JM920310' });
    expect(needle(digital)).toMatchObject({ tier: 'unavailable', reason: 'wrong-cluster' });
    expect(needle(digital)?.statusLabel).toBe('NOT AVAILABLE FOR YOUR CAR');
    expect(clusterMismatch(digital, 'instrument-cluster-needle-sweep')).toBe('analogue');
    expect(clusterMismatch(analogue, 'instrument-cluster-needle-sweep')).toBeUndefined();
  });

  it('stays marked when the car connected but its cluster is not one we know', () => {
    expect(needle(withDetected(slavia, { clusterPart: '2GM920740', modelYear: 2023 }))?.needsCluster).toBe(
      'analogue',
    );
  });

  it('only cluster-dependent features change with the detected cluster', () => {
    for (const { brand, model } of [
      { brand: 'skoda', model: 'slavia' },
      { brand: 'volkswagen', model: 'virtus' },
      { brand: 'skoda', model: 'kushaq' },
    ] as const) {
      const base = defaultSelection(brand, model);
      for (const cluster of ['analogue', 'digital'] as Cluster[]) {
        const before = new Map(featuresFor(base).map((f) => [f.id, f.tier]));
        for (const f of featuresFor(withDetected(base, { cluster }))) {
          if (f.tier === before.get(f.id)) continue;
          expect(clusterRequirement(brand, model, f.id), `${model} ${f.id}`).toBeDefined();
          expect(f.reason).toBe('wrong-cluster');
        }
      }
    }
  });

  it('the Kushaq needle sweep does not depend on the cluster — its catalogue names none', () => {
    const kushaq = withDetected(defaultSelection('skoda', 'kushaq'), { cluster: 'digital' });
    expect(needle(kushaq)).toMatchObject({ statusLabel: 'AVAILABLE FOR YOUR CAR' });
  });
});
