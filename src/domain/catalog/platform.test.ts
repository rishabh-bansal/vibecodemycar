import { describe, expect, it } from 'vitest';
import { platformKeyOf } from './data.ts';
import {
  DEFAULT_FAMILY,
  familyModelNames,
  familyModels,
  familyOf,
  familyOfBcmPart,
  modelOfListing,
  platformFamily,
} from './platform.ts';
import { sanitizeSelection, withDetected, withModel } from './selection.ts';
import { OTHER_MODEL } from './types.ts';
import { defaultSelection, modelChoicesFor, modelLabel } from './vehicles.ts';

describe('platform families', () => {
  it('maps every platform tag the data uses to its family, with one helper', () => {
    expect(platformFamily('MQB-A0-IN')).toBe('MQB-A0-IN');
    expect(platformFamily('MQB-37')).toBe('MQB');
    expect(platformFamily('MQB-B')).toBe('MQB');
    expect(platformFamily('PQ26')).toBe('PQ');
    expect(platformFamily(null)).toBeNull();
    expect(platformFamily).toBe(platformKeyOf);
  });

  it('groups the India 2.0 sisters and the larger MQB cars, across both brands', () => {
    expect(familyModels('MQB-A0-IN').sort()).toEqual([
      'skoda-kushaq',
      'skoda-kylaq',
      'skoda-slavia',
      'volkswagen-taigun',
      'volkswagen-virtus',
    ]);
    expect(familyModels('MQB').sort()).toEqual([
      'skoda-kodiaq',
      'skoda-octavia-rs',
      'skoda-superb',
      'volkswagen-golf-gti',
      'volkswagen-tayron',
      'volkswagen-tiguan',
    ]);
    expect(familyModelNames('MQB-A0-IN')).toMatch(/^[A-Z][a-z]+(, [A-Z][a-z]+)* and [A-Z][a-z]+$/);
  });

  it('reads the family from the body computer part number, any spacing', () => {
    expect(familyOfBcmPart('2Q0937089D')).toBe('MQB-A0-IN');
    expect(familyOfBcmPart('2Q0 937 084 AF')).toBe('MQB-A0-IN');
    expect(familyOfBcmPart('5Q0937084')).toBe('MQB');
    expect(familyOfBcmPart('3Q0937086')).toBe('MQB');
    expect(familyOfBcmPart('6R0937087')).toBeUndefined();
    expect(familyOfBcmPart(undefined)).toBeUndefined();
  });

  it('names the model a listing id belongs to, longest model first', () => {
    expect(modelOfListing('skoda-kushaq-monte-carlo-manufactured-before-april-2024')).toBe('skoda-kushaq');
    expect(modelOfListing('skoda-superb')).toBe('skoda-superb');
    expect(modelOfListing('skoda-octavia-rs-base')).toBe('skoda-octavia-rs');
    expect(modelOfListing('skoda-rapid-monte-carlo')).toBeUndefined();
  });
});

describe('"Other model"', () => {
  it('is the last choice of each brand, named plainly', () => {
    for (const brand of ['skoda', 'volkswagen'] as const) {
      expect(modelChoicesFor(brand).at(-1)).toEqual({ id: OTHER_MODEL, label: 'Other model' });
    }
    expect(modelLabel(OTHER_MODEL)).toBe('Other model');
    expect(withModel(defaultSelection('skoda', 'kushaq'), OTHER_MODEL).model).toBe(OTHER_MODEL);
  });

  it('starts from the most common family and settles on the one its body computer names', () => {
    const other = defaultSelection('volkswagen', OTHER_MODEL);
    expect(other.model).toBe(OTHER_MODEL);
    expect(familyOf(other)).toEqual({ family: DEFAULT_FAMILY, confirmed: false });
    const read = withDetected(other, { bcmPart: '2Q0937089D', platform: 'MQB-A0-IN' });
    expect(familyOf(read)).toEqual({ family: 'MQB-A0-IN', confirmed: true });
  });

  it('a listed model is its own family whatever was read', () => {
    const kushaq = withDetected(defaultSelection('skoda', 'kushaq'), { platform: 'MQB' });
    expect(familyOf(kushaq)).toEqual({ family: 'MQB-A0-IN', confirmed: true });
  });

  it('survives a reload, with the platform the car reported', () => {
    const saved = withDetected(defaultSelection('skoda', OTHER_MODEL), {
      bcmPart: '5Q0937084AF',
      platform: 'MQB',
      modelYear: 2023,
    });
    const restored = sanitizeSelection(JSON.parse(JSON.stringify(saved)));
    expect(restored).toEqual(saved);
    expect(familyOf(restored)).toEqual({ family: 'MQB', confirmed: true });
    // A damaged platform is dropped on its own; the car stays.
    const damaged = sanitizeSelection({ ...saved, detected: { bcmPart: '5Q0937084AF', platform: 'MQB-9' } });
    expect(damaged.model).toBe(OTHER_MODEL);
    expect(damaged.detected).toEqual({ bcmPart: '5Q0937084AF' });
  });
});
