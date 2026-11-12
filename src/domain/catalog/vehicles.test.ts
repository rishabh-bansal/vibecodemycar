import { describe, expect, it } from 'vitest';
import { APP_DATA } from './data.ts';
import { type CarSelection, OTHER_VARIANT } from './types.ts';
import {
  carSummary,
  defaultSelection,
  findVehicle,
  modelsFor,
  periodOfBuild,
  platformOfModel,
  resolvePeriod,
  titleCase,
} from './vehicles.ts';

const car = (over: Partial<CarSelection> = {}): CarSelection => ({
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
  ...over,
});

describe('titleCase', () => {
  it('formats slugs with known acronyms', () => {
    expect(titleCase('monte-carlo')).toBe('Monte Carlo');
    expect(titleCase('octavia-rs')).toBe('Octavia RS');
    expect(titleCase('golf-gti')).toBe('Golf GTI');
  });
});

describe('model and variant options', () => {
  it('lists only models that exist in the data, per brand, sorted', () => {
    const skoda = modelsFor('skoda').map((m) => m.id);
    expect(skoda).toContain('kushaq');
    expect(skoda).not.toContain('taigun');
    expect(skoda).toEqual([...skoda].sort((a, b) => a.localeCompare(b)));
  });

  it('every model in the data is offered under its brand', () => {
    for (const v of APP_DATA.vehicles) expect(modelsFor(v.brand).some((m) => m.id === v.model)).toBe(true);
  });

  it('settles the platform from brand and model alone: every variant of a model shares one', () => {
    for (const v of APP_DATA.vehicles)
      expect(platformOfModel(v.brand, v.model)).toBe(v.platform ?? undefined);
  });

  it('defaultSelection names a real model and no variant', () => {
    expect(defaultSelection()).toMatchObject({ brand: 'skoda', model: 'kushaq', variant: OTHER_VARIANT });
    expect(defaultSelection('volkswagen', 'no-such-model').model).toBe(modelsFor('volkswagen')[0]?.id);
  });
});

describe('carSummary', () => {
  it('names the car, then what the car reported', () => {
    const sel = defaultSelection('skoda', 'kushaq');
    expect(carSummary(sel)).toBe('Škoda Kushaq');
    expect(carSummary({ ...sel, detected: { modelYear: 2023, cluster: 'digital' } })).toBe(
      'Škoda Kushaq · 2023 · Digital cluster',
    );
  });
});

describe('build period', () => {
  it('reads the period from a build id', () => {
    expect(periodOfBuild('skoda-kushaq-monte-carlo-manufactured-before-april-2024')).toBe('pre-2024-04');
    expect(periodOfBuild('skoda-kushaq-monte-carlo-manufactured-post-april-2024')).toBe('post-2024-04');
    expect(periodOfBuild('skoda-kushaq-signature')).toBeNull();
  });

  it('derives the period from the year outside 2024', () => {
    expect(resolvePeriod(car({ year: 2022 }))).toBe('pre-2024-04');
    expect(resolvePeriod(car({ year: 2025 }))).toBe('post-2024-04');
  });

  it('refuses to guess the 2024 period when the evidence is split', () => {
    const split = car({ year: 2024 });
    expect(resolvePeriod(split)).toBeNull();
    expect(resolvePeriod({ ...split, period2024: 'pre-2024-04' })).toBe('pre-2024-04');
  });

  it('has no vehicle for the "other" variant', () => {
    expect(findVehicle(car({ variant: OTHER_VARIANT }))).toBeNull();
  });
});
