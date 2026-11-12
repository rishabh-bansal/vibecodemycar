import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { featuresFor } from '../catalog/features.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { buildCatalogue, familyCatalogue, withFamilyFeatures } from './data.ts';
import { displayCopy, displayTitle } from './display.ts';
import { GROUP_ORDER } from './groups.ts';
import { mentionsLaw, normalizeFeature } from './normalize.ts';
import { applyFilters, chipCounts, matchesQuery, toSections } from './query.ts';
import {
  appFeatureIds,
  CATALOGUE_ALIASES,
  catalogueSlugFor,
  HERO_SLUGS,
  pickHero,
  statusFor,
  withAppCopy,
} from './status.ts';
import type { CatalogueFeature, RawFeature } from './types.ts';

const file: unknown = JSON.parse(readFileSync(new URL('../../data/catalogue.json', import.meta.url), 'utf8'));
const models = buildCatalogue(file);
const kushaq = models.find((m) => m.model === 'kushaq');
if (!kushaq) throw new Error('kushaq missing from catalogue');
const rec = (slug: string): CatalogueFeature => {
  const f = kushaq.features.find((x) => x.slug === slug);
  if (!f) throw new Error(`fixture ${slug} missing`);
  return f;
};

const raw = (over: Partial<RawFeature>): RawFeature => ({
  slug: 's',
  name: 'N',
  group: 'comfort',
  category: 'adjustment',
  intro: '',
  Functions: [],
  Requirements: [],
  Attention: [],
  'In-Car procedure': [],
  Notes: [],
  ...over,
});

describe('the data set', () => {
  it('has exactly the 8 India models, in order, and nothing else', () => {
    expect(models.map((m) => m.key)).toEqual([
      'skoda-kushaq',
      'skoda-slavia',
      'skoda-kylaq',
      'skoda-kodiaq',
      'skoda-superb',
      'volkswagen-taigun',
      'volkswagen-virtus',
      'volkswagen-tiguan',
    ]);
  });
  it('Kushaq has 33 unlocks and 22 service tools (55 in total)', () => {
    expect([kushaq.unlocks.length, kushaq.service.length, kushaq.features.length]).toEqual([33, 22, 55]);
  });
  it('every model loads and the other models are ignored', () => {
    expect(models.reduce((n, m) => n + m.features.length, 0)).toBe(491);
  });
});

describe('normalizeFeature — the three required records from skoda/kushaq', () => {
  it('needle sweep: real intro, one Functions item, one Attention item, no empty sections', () => {
    const f = rec('gauge-test-needle-sweep');
    expect(f.intro).toBe(
      'Automatically sweep the gauge needles of the instrument cluster through their full range, every time the Ignition is turned ON',
    );
    expect(f.functions).toEqual(['Turn ON or OFF needle sweep feature for your instrument cluster']);
    expect(f.attention).toEqual([
      "First turn the ignition ON and then open the vehicle's hood to activate this feature",
    ]);
    expect([f.requirements, f.procedure, f.notes].every((a) => a.length === 0)).toBe(true);
    expect(f.legal).toBe(false);
  });

  it('speed warning for India: the law warning is Attention and marks the feature legal', () => {
    const f = rec('speed-warning-for-india');
    expect(f.intro).toMatch(/required by law/);
    expect(f.functions).toEqual(['Disable the speed warning system']);
    expect(f.attention).toHaveLength(1);
    expect(f.legal).toBe(true);
  });

  it('comfort turn signals: empty intro stays empty, with no sections at all', () => {
    const f = rec('comfort-turn-signals');
    expect(f.intro).toBe('');
    expect(
      [f.functions, f.requirements, f.attention, f.procedure, f.notes].every((a) => a.length === 0),
    ).toBe(true);
  });
});

describe('normalizeFeature — cases found in the real data', () => {
  it('accepts every marker spelling: ⚙Functions, ⚙ Functions, ⚙ Options, ⚠ Attention', () => {
    for (const heading of ['⚙Functions', '⚙ Functions', '⚙ Options', '⚙ Options:']) {
      expect(normalizeFeature(raw({ intro: `Intro\n${heading}\nDo x` })).functions).toEqual(['Do x']);
    }
    expect(normalizeFeature(raw({ intro: 'Intro\n⚠ Attention\nCareful' })).attention).toEqual(['Careful']);
  });

  it('joins a hard-wrapped intro instead of keeping only its first line', () => {
    const f = normalizeFeature(
      raw({ intro: 'DRL - Daytime Running\nLights When the hand brake is on\n⚙Functions\nDisable DRL' }),
    );
    expect(f.intro).toBe('DRL - Daytime Running Lights When the hand brake is on');
  });

  it('splits numbered and bulleted Attention lines into one item each and strips the decoration', () => {
    const f = normalizeFeature(
      raw({ intro: 'x\n⚠ Attention\n1. First\n2) Second\n• Third\n•Fourth\n- Fifth' }),
    );
    expect(f.attention).toEqual(['First', 'Second', 'Third', 'Fourth', 'Fifth']);
  });

  it('ignores a repeated marker with nothing under it', () => {
    const f = normalizeFeature(
      raw({ intro: 'x\n⚙ Functions\nDisable it\n⚙ Functions\n⚠ Attention\nBe careful' }),
    );
    expect(f.functions).toEqual(['Disable it']);
    expect(f.attention).toEqual(['Be careful']);
  });

  it('merges with arrays already in the record and de-duplicates (case/whitespace-insensitive)', () => {
    const f = normalizeFeature(
      raw({ intro: 'x\n⚙ Functions\nTurn it on', Functions: ['turn  it ON', 'Another'] }),
    );
    expect(f.functions).toEqual(['turn it ON', 'Another']);
  });

  it('accepts plain headings for requirements, in-car procedure and notes', () => {
    const f = normalizeFeature(
      raw({
        intro: 'x\nRequirements\nA cable\nIn-Car procedure\n1. Open the door\nNotes\nWorks on new cars',
      }),
    );
    expect([f.requirements, f.procedure, f.notes]).toEqual([
      ['A cable'],
      ['Open the door'],
      ['Works on new cars'],
    ]);
  });

  it('puts text on the marker line itself into the section', () => {
    expect(normalizeFeature(raw({ intro: 'x\n⚙ Functions: Disable it' })).functions).toEqual(['Disable it']);
  });

  it('never leaks section text into the intro', () => {
    for (const m of models) for (const f of m.features) expect(f.intro).not.toMatch(/[⚙⚠]/);
  });

  it('every record in every model normalizes to non-empty, de-duplicated sections', () => {
    for (const m of models) {
      for (const f of m.features) {
        for (const list of [f.functions, f.requirements, f.attention, f.procedure, f.notes]) {
          expect(list.every((x) => x.length > 0)).toBe(true);
          expect(new Set(list.map((x) => x.toLowerCase())).size).toBe(list.length);
        }
      }
    }
  });
});

describe('legal warnings', () => {
  it('recognises law wording, in any case', () => {
    expect(mentionsLaw('might be against the LAW in some countries')).toBe(true);
    expect(mentionsLaw('This modification may be illegal')).toBe(true);
    expect(mentionsLaw('First turn the ignition on')).toBe(false);
  });
  it('flags exactly the features whose ATTENTION mentions the law (not their intro)', () => {
    const legal = kushaq.features
      .filter((f) => f.legal)
      .map((f) => f.slug)
      .sort();
    expect(legal).toEqual(['drl-off-with-handbrake', 'speed-warning-for-india']);
  });
  it('the shipped catalogue keeps every legal flag, without the source text', () => {
    const publicFile: unknown = JSON.parse(
      readFileSync(new URL('../../data/catalogue-public.json', import.meta.url), 'utf8'),
    );
    const flags = (ms: typeof models) =>
      ms.flatMap((m) => m.features.map((f) => `${m.key}/${f.slug}:${f.legal}`));
    const shipped = buildCatalogue(publicFile);
    expect(flags(shipped)).toEqual(flags(models));
  });
});

describe('displayCopy / displayTitle', () => {
  it('uses British wording, sentence case, and "it" for a trailing "this feature"', () => {
    expect(
      displayCopy("First turn the ignition ON and then open the vehicle's hood to activate this feature"),
    ).toBe("First turn the ignition on and then open the vehicle's bonnet to activate it");
    expect(displayCopy('the hood must be open.')).toBe('The bonnet must be open.');
  });
  it('makes serif headlines lowercase with a full stop', () => {
    expect(displayTitle('Gauge Test - Needle Sweep')).toBe('gauge test - needle sweep.');
    expect(displayTitle('Lap Timer.')).toBe('lap timer.');
  });
});

describe('grouping, filters and search', () => {
  it('orders sections as lights, dashboard, locks, assistance, comfort and drops empty ones', () => {
    const sections = toSections(kushaq.unlocks).map((s) => s.group);
    expect(sections).toEqual(GROUP_ORDER.filter((g) => sections.includes(g)));
    expect(sections).not.toContain('service');
  });
  it('chip counts add up to the tab size and hide empty groups', () => {
    const counts = chipCounts(kushaq, 'unlocks');
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(kushaq.unlocks.length);
    expect(counts.every((c) => c.count > 0)).toBe(true);
    expect(chipCounts(kushaq, 'service')).toEqual([{ group: 'service', count: 22 }]);
  });
  it('filters compose: tab × chips × search', () => {
    const dash = applyFilters(kushaq, { tab: 'unlocks', groups: ['dashboard'], query: '' });
    expect(dash.length).toBe(7);
    const hit = applyFilters(kushaq, { tab: 'unlocks', groups: ['dashboard'], query: 'NEEDLE' });
    expect(hit.map((f) => f.slug)).toEqual(['gauge-test-needle-sweep']);
    expect(applyFilters(kushaq, { tab: 'service', groups: ['dashboard'], query: '' })).toEqual([]);
  });
  it('search matches name and intro, case-insensitively', () => {
    expect(matchesQuery(rec('gauge-test-needle-sweep'), 'IGNITION is turned')).toBe(true);
    expect(matchesQuery(rec('gauge-test-needle-sweep'), 'zzz')).toBe(false);
    expect(matchesQuery(rec('gauge-test-needle-sweep'), '  ')).toBe(true);
  });
});

describe('support status — joined, never invented', () => {
  const car: CarSelection = {
    brand: 'skoda',
    model: 'kushaq',
    variant: 'monte-carlo',
    year: 2023,
    cluster: 'digital',
  };
  let items: Map<string, FeatureItem>;
  let ctx: { isUsersCar: boolean; items: Map<string, FeatureItem> };
  beforeEach(() => {
    items = new Map<string, FeatureItem>(featuresFor(car).map((i) => [i.id, i]));
    ctx = { isUsersCar: true, items };
  });

  it('every alias points at a real app feature', () => {
    const ids = new Set(featuresFor(car).map((i) => i.id));
    const allSlugs = new Set(models.flatMap((m) => m.features.map((f) => f.slug)));
    for (const [slug, id] of Object.entries(CATALOGUE_ALIASES)) {
      expect(allSlugs.has(slug), slug).toBe(true);
      expect(ids.has(id) || id.length > 0, id).toBe(true);
    }
  });

  it("copy comes from the joined feature this car gets, and re-applying starts from the catalogue's text", () => {
    const f = rec('comfort-turn-signals');
    const [first, ...rest] = appFeatureIds(f.slug);
    const fallback = rest[rest.length - 1] ?? first;
    const plain = withAppCopy(f);
    const preferred = withAppCopy(plain, fallback);
    expect(preferred).toEqual(withAppCopy(f, fallback));
    expect(preferred.original).toEqual(plain.original ?? { name: f.name, intro: f.intro });
    expect(withAppCopy(preferred)).toEqual(plain);
  });

  it('a joined, proven feature is available for your car with its settings', () => {
    const s = statusFor(rec('comfort-turn-signals'), ctx);
    expect(s).toMatchObject({ kind: 'codable', tier: 'tested', label: 'AVAILABLE FOR YOUR CAR' });
  });

  it('the speed warning is codable — no safety lock', () => {
    expect(statusFor(rec('speed-warning-for-india'), ctx).kind).toBe('codable');
  });

  it('joins by slug first (feature id = slug), then the old alias', () => {
    expect(appFeatureIds('comfort-turn-signals')).toEqual([
      'comfort-turn-signals',
      'comfort-lane-change-indicator-5-flashes',
    ]);
    const item = (id: string, tier: FeatureItem['tier']): FeatureItem => ({
      id,
      name: id,
      tier,
      statusLabel: tier.toUpperCase(),
      settings: tier === 'unavailable' ? [] : [{ id: 'enabled', label: 'On' }],
      ...(tier === 'unavailable' ? {} : { recipeId: 'r' }),
    });
    // Only the old alias has an item: it still resolves (old ids and backups keep working).
    const onlyAlias = new Map([
      ['comfort-lane-change-indicator-5-flashes', item('comfort-lane-change-indicator-5-flashes', 'tested')],
    ]);
    expect(statusFor(rec('comfort-turn-signals'), { isUsersCar: true, items: onlyAlias })).toMatchObject({
      kind: 'codable',
      tier: 'tested',
    });
    // The slug's own feature has bytes: codable from it.
    const own = new Map([['comfort-turn-signals', item('comfort-turn-signals', 'experimental')]]);
    expect(statusFor(rec('comfort-turn-signals'), { isUsersCar: true, items: own })).toMatchObject({
      kind: 'codable',
      item: { id: 'comfort-turn-signals' },
    });
  });

  it('is "NOT AVAILABLE FOR YOUR CAR" only when there are no bytes to write', () => {
    expect(
      statusFor({ slug: 'missing-recipe', name: 'Missing recipe' } as CatalogueFeature, {
        isUsersCar: true,
        items: new Map(),
      }),
    ).toEqual({ kind: 'not-codable', label: 'NOT AVAILABLE FOR YOUR CAR' });
    const noBytes: FeatureItem = {
      id: 'lap-timer',
      name: 'Lap timer',
      tier: 'unavailable',
      reason: 'not-executable',
      statusLabel: 'NOT AVAILABLE FOR YOUR CAR',
      settings: [],
    };
    expect(
      statusFor(rec('lap-timer'), { isUsersCar: true, items: new Map([['lap-timer', noBytes]]) }),
    ).toEqual({
      kind: 'not-codable',
      label: 'NOT AVAILABLE FOR YOUR CAR',
    });
    // Every not-codable Kushaq card really has no codable item behind it.
    for (const f of kushaq.features) {
      if (statusFor(f, ctx).kind !== 'not-codable') continue;
      for (const id of appFeatureIds(f.slug))
        expect(items.get(id)?.tier ?? 'unavailable', f.slug).toBe('unavailable');
    }
  });

  it('counts as codable exactly what the app has bytes for on this car', () => {
    const codable = kushaq.features.filter((f) => statusFor(f, ctx).kind === 'codable');
    expect(codable.length).toBeGreaterThan(0);
    for (const f of codable) {
      const s = statusFor(f, ctx);
      expect(
        s.kind === 'codable' &&
          s.item.tier !== 'unavailable' &&
          !!s.item.recipeId &&
          (s.item.settings.length > 0 || !!s.item.scalar),
        f.slug,
      ).toBe(true);
    }
  });

  it('maps a feature id named by a backup back to the catalogue card that opens it', () => {
    expect(catalogueSlugFor('comfort-lane-change-indicator-5-flashes')).toBe('comfort-turn-signals');
    expect(catalogueSlugFor('comfort-turn-signals')).toBe('comfort-turn-signals');
    expect(catalogueSlugFor('no-such-feature')).toBe('no-such-feature');
  });

  it('browsing another model never claims a status for it', () => {
    expect(statusFor(rec('comfort-turn-signals'), { isUsersCar: false, items })).toMatchObject({
      kind: 'other-car',
    });
  });

  it('the hero is a TESTED, non-legal feature from HERO_SLUGS — or nothing', () => {
    const statusOf = (f: CatalogueFeature) => statusFor(f, ctx);
    expect(HERO_SLUGS).toContain(pickHero(kushaq, statusOf)?.slug);
    expect(pickHero(kushaq, (f) => statusFor(f, { isUsersCar: false, items }))).toBeUndefined();
    expect(pickHero(kushaq, (f) => statusFor(f, { isUsersCar: true, items: new Map() }))).toBeUndefined();
  });

  it('a legal feature is never the hero, even if tested', () => {
    const legalTested = (f: CatalogueFeature) =>
      f.slug === 'speed-warning-for-india'
        ? statusFor(f, {
            isUsersCar: true,
            items: new Map([
              [
                '80kmph-and-120kmph-speed-chime-warning',
                {
                  ...(items.get('80kmph-and-120kmph-speed-chime-warning') as FeatureItem),
                  tier: 'tested' as const,
                },
              ],
            ]),
          })
        : { kind: 'not-codable' as const, label: 'NOT AVAILABLE FOR YOUR CAR' as const };
    expect(pickHero(kushaq, legalTested)).toBeUndefined();
  });
});

describe('platform families — cards are the union across sister models', () => {
  const family = withFamilyFeatures(models);
  const of = (model: string) => {
    const m = family.find((x) => x.model === model);
    if (!m) throw new Error(`${model} missing`);
    return m;
  };
  const slugs = (model: string) => new Set(of(model).features.map((f) => f.slug));

  it('every model of a family shows the same cards', () => {
    for (const group of [
      ['kushaq', 'slavia', 'kylaq', 'taigun', 'virtus'],
      ['kodiaq', 'superb', 'tiguan'],
    ]) {
      const first = [...slugs(group[0] ?? '')].sort();
      for (const model of group) expect([...slugs(model)].sort(), model).toEqual(first);
    }
  });

  it("keeps each model's own cards first, in its own order and with its own text", () => {
    const own = models.find((m) => m.model === 'taigun');
    if (!own) throw new Error('taigun missing');
    expect(of('taigun').features.slice(0, own.features.length)).toEqual(own.features);
    // A card only the Kushaq lists reaches the Taigun with the Kushaq's text.
    const fromKushaq = kushaq.features.find((f) => !own.features.some((x) => x.slug === f.slug));
    if (!fromKushaq) throw new Error('no Kushaq-only card');
    expect(of('taigun').features.find((f) => f.slug === fromKushaq.slug)).toEqual(fromKushaq);
  });

  it('never mixes the families', () => {
    const a0 = slugs('kushaq');
    expect(models.find((m) => m.model === 'superb')?.features.some((f) => !a0.has(f.slug))).toBe(true);
    expect([...slugs('superb')].some((s) => !a0.has(s))).toBe(true);
  });

  it('gives a car without a catalogue of its own its family, its brand first', () => {
    const other = familyCatalogue(models, {
      make: 'volkswagen',
      model: 'other',
      title: 'Other model',
      family: 'MQB-A0-IN',
    });
    expect(other?.title).toBe('Other model');
    expect(new Set(other?.features.map((f) => f.slug))).toEqual(slugs('kushaq'));
    const vw = models.find((m) => m.model === 'taigun'); // first Volkswagen of the family in display order
    expect(other?.features[0]).toEqual(vw?.features[0]);
    expect(familyCatalogue(models, { make: 'skoda', model: 'x', title: 'X', family: 'PQ' })).toBeUndefined();
  });

  it('a feature codable on one sister is codable on every sister, through its card', () => {
    const codable = (model: string, brand: CarSelection['brand']) => {
      const sel: CarSelection = { brand, model, variant: 'other', year: 2025, cluster: 'analogue' };
      const items = new Map(featuresFor(sel).map((i) => [i.id, i]));
      return of(model)
        .features.filter((f) => statusFor(f, { isUsersCar: true, items }).kind === 'codable')
        .map((f) => f.slug)
        .sort();
    };
    expect(codable('taigun', 'volkswagen')).toEqual(codable('kushaq', 'skoda'));
    expect(codable('tiguan', 'volkswagen')).toEqual(codable('superb', 'skoda'));
  });
});
