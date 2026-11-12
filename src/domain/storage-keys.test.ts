import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_KEYS, migrateLegacyKeys, moveLegacyKeys, SESSION_KEYS } from './storage-keys.ts';

const memory = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe('storage keys saved under the old app name', () => {
  it('moves every old key to its new name once, then deletes the old one', () => {
    const local = memory({
      'obdcraft.car.v1': '{"state":{},"version":2}',
      'obdcraft.cloud.v1': '{"token":"t"}',
      'obdcraft.cloud.optout': '1',
      'obdcraft.cloud.previous': '["p"]',
      'obdcraft.diagnostics.v1': '[]',
      unrelated: 'x',
    });
    const session = memory({ 'obdcraft.diag-boot': '3' });
    const moved = migrateLegacyKeys(local, session);
    expect(moved.sort()).toEqual([...Object.values(LOCAL_KEYS), ...Object.values(SESSION_KEYS)].sort());
    expect(Object.fromEntries(local.map)).toEqual({
      'vibecode-my-car.car.v1': '{"state":{},"version":2}',
      'vibecode-my-car.cloud.v1': '{"token":"t"}',
      'vibecode-my-car.cloud.optout': '1',
      'vibecode-my-car.cloud.previous': '["p"]',
      'vibecode-my-car.diagnostics.v1': '[]',
      unrelated: 'x',
    });
    expect(Object.fromEntries(session.map)).toEqual({ 'vibecode-my-car.diag-boot': '3' });
    // A second start finds nothing to move.
    expect(migrateLegacyKeys(local, session)).toEqual([]);
  });

  it('keeps a value already under the new name and still removes the old key', () => {
    const local = memory({ 'obdcraft.car.v1': 'old', 'vibecode-my-car.car.v1': 'new' });
    expect(moveLegacyKeys(local, [LOCAL_KEYS.car])).toEqual([]);
    expect(Object.fromEntries(local.map)).toEqual({ 'vibecode-my-car.car.v1': 'new' });
  });

  it('leaves the old key in place when the new one cannot be written', () => {
    const local = memory({ 'obdcraft.cloud.v1': 'token' });
    local.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(moveLegacyKeys(local, [LOCAL_KEYS.cloud])).toEqual([]);
    expect(local.map.get('obdcraft.cloud.v1')).toBe('token');
  });

  it('does nothing without storage', () => {
    expect(migrateLegacyKeys(undefined, undefined)).toEqual([]);
  });
});

describe('app start with an old-name car selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('the car store hydrates from it, and only the new key remains', async () => {
    const local = memory();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', memory());
    const selection = { brand: 'skoda', model: 'slavia', variant: 'style', year: 2023, cluster: 'digital' };
    localStorage.setItem('obdcraft.car.v1', JSON.stringify({ state: { selection }, version: 2 }));
    vi.resetModules();
    await import('../infra/storage/migrate-on-start.ts');
    const { useCarStore } = await import('../state/car-store.ts');
    expect(useCarStore.getState().selection).toMatchObject({ brand: 'skoda', model: 'slavia' });
    expect(localStorage.getItem('obdcraft.car.v1')).toBeNull();
    expect(JSON.parse(localStorage.getItem('vibecode-my-car.car.v1') ?? '{}').state.selection.model).toBe(
      'slavia',
    );
  });

  it('the cloud log keeps its device token, previous tokens and opt-out', async () => {
    vi.stubGlobal('localStorage', memory());
    vi.stubGlobal('sessionStorage', memory());
    const enrollment = {
      deviceId: 'dev-1',
      token: 'tok-secret',
      label: 'phone',
      role: 'collector',
      enrolledAt: '2026-10-01T00:00:00.000Z',
    };
    localStorage.setItem('obdcraft.cloud.v1', JSON.stringify(enrollment));
    localStorage.setItem('obdcraft.cloud.previous', JSON.stringify(['tok-old']));
    localStorage.setItem('obdcraft.cloud.optout', '1');
    vi.resetModules();
    await import('../infra/storage/migrate-on-start.ts');
    const cloud = await import('../infra/cloud/config.ts');
    expect(cloud.readEnrollment()).toEqual(enrollment);
    expect(cloud.readPreviousTokens()).toEqual(['tok-old']);
    expect(cloud.uploadsOptedOut()).toBe(true);
    for (const old of ['obdcraft.cloud.v1', 'obdcraft.cloud.previous', 'obdcraft.cloud.optout'])
      expect(localStorage.getItem(old)).toBeNull();
  });
});
