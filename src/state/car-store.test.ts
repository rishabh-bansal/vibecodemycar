import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CarSelection } from '../domain/catalog/types.ts';
import { useCarStore } from './car-store.ts';

const MONTE_CARLO: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const PAIRING = { fingerprint: 'a'.repeat(64), masked: 'MEXK…1234' };

beforeEach(() => useCarStore.setState({ selection: MONTE_CARLO, pairing: PAIRING }));

describe('car store — choosing a car', () => {
  it('keeps the details and the VIN pairing when the same brand and model are picked again', () => {
    useCarStore.getState().setBrand('skoda');
    useCarStore.getState().setModel('kushaq');
    expect(useCarStore.getState()).toMatchObject({ selection: MONTE_CARLO, pairing: PAIRING });
  });

  it('starts over for a different model: details reset and the pairing is dropped', () => {
    useCarStore.getState().setModel('slavia');
    expect(useCarStore.getState().selection.model).toBe('slavia');
    expect(useCarStore.getState().pairing).toBeUndefined();
  });

  it('starts over for a different brand', () => {
    useCarStore.getState().setBrand('volkswagen');
    expect(useCarStore.getState().selection.brand).toBe('volkswagen');
    expect(useCarStore.getState().pairing).toBeUndefined();
  });
});

describe('car store — what the car reports on connect', () => {
  it('records the detected cluster and model year, keeping the pairing', () => {
    useCarStore.getState().setDetected({ cluster: 'analogue', modelYear: 2022, clusterPart: '6JM920310' });
    expect(useCarStore.getState().selection).toMatchObject({
      year: 2022,
      cluster: 'analogue',
      detected: { cluster: 'analogue', modelYear: 2022 },
    });
    expect(useCarStore.getState().pairing).toEqual(PAIRING);
  });

  it('forgets it when a different car is chosen', () => {
    useCarStore.getState().setDetected({ cluster: 'digital' });
    useCarStore.getState().setModel('slavia');
    expect(useCarStore.getState().selection.detected).toBeUndefined();
  });
});

describe('car store — selections saved by earlier versions', () => {
  const KEY = 'vibecode-my-car.car.v1';
  afterEach(() => localStorage.removeItem(KEY));

  it('loads a v1 selection (variant, year, build period, cluster) without resetting the car', async () => {
    const v1 = { ...MONTE_CARLO, year: 2024, period2024: 'pre-2024-04' };
    localStorage.setItem(KEY, JSON.stringify({ state: { selection: v1, pairing: PAIRING }, version: 1 }));
    await useCarStore.persist.rehydrate();
    expect(useCarStore.getState().selection).toEqual(v1);
    expect(useCarStore.getState().pairing).toEqual(PAIRING);
  });

  it('ignores the photo colour an earlier version saved', async () => {
    const saved = { ...MONTE_CARLO, colour: 'candy-white' };
    localStorage.setItem(KEY, JSON.stringify({ state: { selection: saved, pairing: PAIRING }, version: 2 }));
    await useCarStore.persist.rehydrate();
    expect(useCarStore.getState().selection).toEqual(MONTE_CARLO);
    expect(useCarStore.getState().selection).not.toHaveProperty('colour');
  });

  it('keeps the brand and model of a v1 selection whose variant no longer exists', async () => {
    const stale = { ...MONTE_CARLO, model: 'slavia', variant: 'platinum' };
    localStorage.setItem(KEY, JSON.stringify({ state: { selection: stale }, version: 1 }));
    await useCarStore.persist.rehydrate();
    expect(useCarStore.getState().selection).toMatchObject({
      brand: 'skoda',
      model: 'slavia',
      variant: 'other',
    });
  });

  it('saves brand and model, and what the car reported', async () => {
    useCarStore.getState().setModel('slavia');
    useCarStore.getState().setDetected({ cluster: 'analogue' });
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    expect(saved.version).toBe(2);
    expect(saved.state.selection).toMatchObject({
      brand: 'skoda',
      model: 'slavia',
      detected: { cluster: 'analogue' },
    });
  });
});
