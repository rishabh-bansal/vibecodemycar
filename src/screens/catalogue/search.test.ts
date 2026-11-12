import { describe, expect, it } from 'vitest';
import file from '../../data/catalogue.json' with { type: 'json' };
import { featuresFor } from '../../domain/catalog/features.ts';
import type { CarSelection, FeatureItem } from '../../domain/catalog/types.ts';
import { buildCatalogue, withAppCopyModels } from '../../domain/catalogue/data.ts';
import { applyFilters, codableFirst } from '../../domain/catalogue/query.ts';
import { statusFor } from '../../domain/catalogue/status.ts';
import type { CatalogueFeature } from '../../domain/catalogue/types.ts';
import { featureSearchText, matchesSearch, normalizeSearch, SYNONYMS, searchText } from './search.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const kushaq = withAppCopyModels(buildCatalogue(file)).find((m) => m.model === 'kushaq');
if (!kushaq) throw new Error('fixture');
const items = new Map<string, FeatureItem>(featuresFor(CAR).map((i) => [i.id, i]));
const statusOf = (f: CatalogueFeature) => statusFor(f, { isUsersCar: true, items });
const text = (f: CatalogueFeature) => {
  const s = statusOf(f);
  return featureSearchText(f, s.kind === 'codable' ? s.item : undefined);
};
/** Slugs the features screen would list for this query: unlocks and service, codable first. */
const search = (q: string) =>
  codableFirst(
    [
      ...applyFilters(kushaq, { tab: 'unlocks', groups: [], query: q }, (f, x) => matchesSearch(text(f), x)),
      ...applyFilters(kushaq, { tab: 'service', groups: [], query: q }, (f, x) => matchesSearch(text(f), x)),
    ],
    (f) => statusOf(f).kind === 'codable',
  ).map((f) => f.slug);

describe('matchesSearch', () => {
  it('matches the whole query, or every word as the start of a word, ignoring case and punctuation', () => {
    const t = searchText(['Lane Change Blinks', 'Sets how many times the indicators blink.']);
    expect(matchesSearch(t, 'LANE change')).toBe(true);
    expect(matchesSearch(t, 'indic blink')).toBe(true);
    expect(matchesSearch(t, 'ane')).toBe(false);
    expect(matchesSearch(t, 'zzz')).toBe(false);
    expect(matchesSearch(t, '   ')).toBe(true);
  });

  it('finds a feature by any word people use for it', () => {
    const cases: [string, string, string][] = [
      ['DRL', 'Daytime running lights stay on in AUTO', 'DRLs'],
      ['daytime running lights', 'DRL On with AUTO', 'daytime'],
      ['blinks', 'Comfort turn signals', 'comfort indicator'],
      ['comfort indicator', 'Lane change flashes', 'lane change'],
      ['needle sweep', 'Gauge test on start', 'gauge test'],
      ['gauge test', 'Needle Sweep', 'needle sweep'],
      ['mirror fold', 'Auto folding mirrors when locked', 'folding mirror'],
      ['coming home', 'Leaving home lights', 'leaving home'],
      ['seatbelt', 'Seat belt warning', 'seat belt'],
    ];
    for (const [query, haystack] of cases)
      expect(matchesSearch(searchText([haystack]), query), query).toBe(true);
  });

  it('keeps the other words of a synonym query', () => {
    expect(matchesSearch(searchText(['DRL on with auto']), 'daytime running light auto')).toBe(true);
    expect(matchesSearch(searchText(['DRL on with auto']), 'daytime running light handbrake')).toBe(false);
  });

  it('never matches a short word inside another word', () => {
    expect(matchesSearch(searchText(['Rear wiper back']), 'ack')).toBe(false);
  });

  it('every synonym is already in its searchable form', () => {
    for (const group of SYNONYMS) for (const p of group) expect(normalizeSearch(p)).toBe(p.toLowerCase());
  });
});

describe('search on the real feature list', () => {
  it('finds features by name, description, setting label, old name and synonym', () => {
    expect(search('lane change')).toContain('comfort-turn-signals');
    expect(search('5 blinks')).toContain('comfort-turn-signals'); // a setting label
    expect(search('comfort turn signals')).toContain('comfort-turn-signals'); // its old name
    expect(search('gauge test')).toContain('gauge-test-needle-sweep');
    expect(search('drl')).toEqual(expect.arrayContaining(['drl-on-with-auto', 'drl-off-with-handbrake']));
    expect(search('seatbelt')).toContain('seat-belt-warning');
    expect(search('coming home')).toContain('coming-home-lights-operation');
  });

  it("still finds a card by the catalogue's own name once friendlier copy replaces it", () => {
    const renamed = kushaq.features.filter((f) => f.original && f.original.name !== f.name);
    expect(renamed.length).toBeGreaterThan(0);
    for (const f of renamed) expect(text(f)).toContain(` ${normalizeSearch(f.original?.name ?? '')} `);
  });

  it('lists what this car can take first, and keeps the catalogue order within each part', () => {
    const results = search('light');
    const codable = results.map((slug) => {
      const f = kushaq.features.find((x) => x.slug === slug) as CatalogueFeature;
      return statusOf(f).kind === 'codable';
    });
    expect(codable.includes(true) && codable.includes(false)).toBe(true);
    expect(codable.indexOf(false)).toBeGreaterThan(codable.lastIndexOf(true));
  });
});

describe('codableFirst', () => {
  it('is a stable split: codable items first, then the rest, each in its original order', () => {
    const list = ['a1', 'b1', 'a2', 'b2', 'a3'];
    expect(codableFirst(list, (x) => x.startsWith('a'))).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    expect(codableFirst([], () => true)).toEqual([]);
  });
});
