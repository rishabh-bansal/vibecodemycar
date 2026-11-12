import { describe, expect, it } from 'vitest';
import type { BackupRecord } from '../domain/backups/schema.ts';
import { featuresFor, findFeature } from '../domain/catalog/features.ts';
import type { CarSelection, FeatureItem } from '../domain/catalog/types.ts';
import { buildRequest, requestLabel, requestSettingLabel } from './request.ts';

const car: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const features = featuresFor(car);
const id = 'comfort-lane-change-indicator-5-flashes';

describe('buildRequest', () => {
  it('builds an apply request for an available feature and a real setting', () => {
    expect(buildRequest({ feature: id, setting: 'value-5' }, { car, features, backups: [] })).toMatchObject({
      kind: 'apply',
      settingId: 'value-5',
    });
  });
  it.each([
    ['no feature', {}],
    ['unknown feature', { feature: 'nope', setting: 'x' }],
    ['unknown setting', { feature: id, setting: 'value-99' }],
    ['missing setting', { feature: id }],
    ['unavailable feature', { feature: 'no-bytes', setting: 'enabled' }],
  ])('refuses %s', (_n, search) => {
    const noBytes: FeatureItem = {
      id: 'no-bytes',
      name: 'No bytes',
      tier: 'unavailable',
      reason: 'not-executable',
      statusLabel: 'NOT AVAILABLE FOR YOUR CAR',
      settings: [],
    };
    expect(buildRequest(search, { car, features: [...features, noBytes], backups: [] })).toBeUndefined();
  });

  describe('free scalar values (value:<n>)', () => {
    const scalar: FeatureItem = {
      id: 'threshold',
      name: 'Threshold',
      tier: 'experimental',
      statusLabel: 'AVAILABLE FOR YOUR CAR',
      recipeId: 'r',
      settings: [{ id: 'default', label: 'Default', value: 4 }],
      scalar: { min: -10, max: 245, step: 1, unit: '°C' },
    };
    const ctx = { car, features: [scalar], backups: [] };

    it('builds an apply request for a value in range, labelled with its unit', () => {
      const req = buildRequest({ feature: 'threshold', setting: 'value:7' }, ctx);
      expect(req).toMatchObject({ kind: 'apply', settingId: 'value:7' });
      expect(req && requestSettingLabel(req)).toBe('7 °C');
    });

    it('still accepts a preset', () => {
      expect(buildRequest({ feature: 'threshold', setting: 'default' }, ctx)).toMatchObject({
        settingId: 'default',
      });
    });

    it.each(['value:246', 'value:-11', 'value:1.5', 'value:', 'value:x'])('refuses %s', (setting) => {
      expect(buildRequest({ feature: 'threshold', setting }, ctx)).toBeUndefined();
    });

    it('refuses a free value for a feature that takes none', () => {
      expect(
        buildRequest({ feature: id, setting: 'value:3' }, { car, features, backups: [] }),
      ).toBeUndefined();
    });
  });
  it('builds an inspect request for a scannable unit and refuses an unknown one', () => {
    expect(buildRequest({ inspect: '09' }, { car, features, backups: [] })).toMatchObject({
      kind: 'inspect',
      unit: '09',
      module: { request: '70E', response: '778' },
    });
    expect(buildRequest({ inspect: '17' }, { car, features, backups: [] })).toMatchObject({
      kind: 'inspect',
      unit: '17',
    });
    expect(buildRequest({ inspect: 'FF' }, { car, features, backups: [] })).toBeUndefined();
  });
  it('needs both a backup and an action for restore/recheck', () => {
    const feature = findFeature(car, id);
    expect(feature).toBeDefined();
    expect(buildRequest({ backup: 'x' }, { car, features, backups: [] })).toBeUndefined();
    expect(buildRequest({ backup: 'x', action: 'restore' }, { car, features, backups: [] })).toBeUndefined();
  });
  it.each([
    ['refused', false],
    ['restored', false],
    ['prepared', true],
    ['unconfirmed', true],
    ['verified', true],
  ] as const)('offers a recheck of a %s record: %s', (status, offered) => {
    const backup = { id: 'b1', status } as BackupRecord;
    const req = buildRequest({ backup: 'b1', action: 'recheck' }, { car, features, backups: [backup] });
    expect(req !== undefined).toBe(offered);
  });
});

describe('labels in plain words', () => {
  it("uses the feature's friendly name and setting label, for a change and for an old backup of it", () => {
    const feature = findFeature(car, id);
    if (!feature) throw new Error('fixture');
    const apply = { kind: 'apply', car, feature, settingId: 'value-5' } as const;
    expect(requestLabel(apply)).toBe('Lane Change Blinks');
    expect(requestSettingLabel(apply)).toBe('5 blinks');
    // A backup made before the friendly names existed still shows them.
    const backup = {
      id: 'b1',
      featureId: id,
      featureName: 'Comfort Lane Change Indicator (5 Flashes)',
      settingId: 'value-5',
      settingLabel: '5',
    } as BackupRecord;
    expect(requestLabel({ kind: 'restore', backup })).toBe('Lane Change Blinks');
    expect(requestSettingLabel({ kind: 'restore', backup })).toBe('5 blinks');
  });

  it('falls back to what the backup recorded when the feature has no friendly copy', () => {
    const backup = {
      id: 'b2',
      featureId: 'gone',
      featureName: 'Old name',
      settingId: 'x',
      settingLabel: 'X',
    } as BackupRecord;
    expect(requestLabel({ kind: 'recheck', backup })).toBe('Old name');
    expect(requestSettingLabel({ kind: 'recheck', backup })).toBe('X');
  });
});
