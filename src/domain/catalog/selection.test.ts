import { describe, expect, it } from 'vitest';
import { sanitizeSelection, withBrand, withDetected, withModel } from './selection.ts';
import { type CarSelection, OTHER_VARIANT } from './types.ts';
import { DEFAULT_YEAR, defaultSelection, modelsFor } from './vehicles.ts';

/** A selection saved by the earlier picker, which asked variant, year, build period and cluster. */
const v1 = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2024,
  cluster: 'digital',
  period2024: 'pre-2024-04',
};

describe('defaultSelection — brand and model only', () => {
  it('asks nothing else: no variant, the default year, nothing detected', () => {
    for (const brand of ['skoda', 'volkswagen'] as const) {
      for (const m of modelsFor(brand)) {
        const sel = defaultSelection(brand, m.id);
        expect(sel).toEqual({
          brand,
          model: m.id,
          variant: OTHER_VARIANT,
          year: DEFAULT_YEAR,
          cluster: 'analogue',
        });
      }
    }
  });
});

describe('sanitizeSelection — stored selections from earlier versions', () => {
  it('loads a v1 selection as it was: variant, year, build period and cluster kept', () => {
    expect(sanitizeSelection(v1)).toEqual(v1);
  });

  it('drops the photo colour an earlier version saved', () => {
    expect(sanitizeSelection({ ...v1, colour: 'candy-white' })).toEqual(v1);
  });

  it('keeps the car when a detail no longer names anything, dropping just that detail', () => {
    expect(sanitizeSelection({ ...v1, variant: 'platinum' })).toMatchObject({
      brand: 'skoda',
      model: 'kushaq',
      variant: OTHER_VARIANT,
    });
    expect(sanitizeSelection({ ...v1, year: '2024' })).toMatchObject({ model: 'kushaq', year: DEFAULT_YEAR });
    expect(sanitizeSelection({ ...v1, cluster: 'hologram' })).toMatchObject({
      model: 'kushaq',
      cluster: 'analogue',
    });
    expect(sanitizeSelection({ ...v1, period2024: 'someday' }).period2024).toBeUndefined();
  });

  it('drops the build period unless it still applies (a named variant and a 2024 model year)', () => {
    expect(sanitizeSelection({ ...v1, year: 2023 }).period2024).toBeUndefined();
    expect(sanitizeSelection({ ...v1, variant: OTHER_VARIANT }).period2024).toBeUndefined();
  });

  it('accepts a selection with brand and model alone', () => {
    expect(sanitizeSelection({ brand: 'volkswagen', model: 'virtus' })).toEqual(
      defaultSelection('volkswagen', 'virtus'),
    );
  });

  it('keeps what a connected car reported, and its year and cluster win', () => {
    const out = sanitizeSelection({
      ...v1,
      detected: { cluster: 'analogue', clusterPart: '6JM920310', modelYear: 2023, junk: 1 },
    });
    expect(out).toMatchObject({ year: 2023, cluster: 'analogue' });
    expect(out.detected).toEqual({ cluster: 'analogue', clusterPart: '6JM920310', modelYear: 2023 });
    expect(out.period2024).toBeUndefined();
  });

  it.each([
    ['garbage', 'nope'],
    ['unknown model', { ...v1, model: 'ghost' }],
    ['unknown brand', { ...v1, brand: 'tata' }],
    ['no model', { brand: 'skoda' }],
  ])('falls back to the default car for %s', (_n, raw) => {
    expect(sanitizeSelection(raw)).toEqual(defaultSelection());
  });

  it('drops unknown keys', () => {
    expect(sanitizeSelection({ ...v1, extra: true })).toEqual(v1);
  });
});

describe('selection transitions', () => {
  const sel = sanitizeSelection(v1);

  it('a different brand or model starts from brand and model alone', () => {
    const detected = withDetected(sel, { cluster: 'digital', modelYear: 2023 });
    expect(withBrand(detected, 'volkswagen')).toEqual(defaultSelection('volkswagen'));
    expect(withModel(detected, 'slavia')).toEqual(defaultSelection('skoda', 'slavia'));
  });

  it('ignores a model the brand does not have', () => {
    expect(withModel(sel, 'virtus')).toBe(sel);
  });

  it('what the car reports becomes the recorded year and cluster', () => {
    const base: CarSelection = defaultSelection('skoda', 'slavia');
    const next = withDetected(base, { cluster: 'digital', clusterPart: '6JM920310', modelYear: 2022 });
    expect(next).toMatchObject({ year: 2022, cluster: 'digital', detected: { cluster: 'digital' } });
  });

  it('a fresh read replaces the previous one', () => {
    const first = withDetected(sel, { cluster: 'digital', modelYear: 2024 });
    const second = withDetected(first, {});
    expect(second.detected).toBeUndefined();
    expect(withDetected(sel, { modelYear: 2023 }).period2024).toBeUndefined();
  });
});
