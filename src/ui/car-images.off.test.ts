import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('car images switched off (VITE_CAR_IMAGES=0)', () => {
  it('references no picture at all', async () => {
    vi.stubEnv('VITE_CAR_IMAGES', '0');
    vi.resetModules();
    const { carImages, heroImage, modelImage } = await import('./car-images.ts');
    expect(carImages('skoda', 'kushaq')).toBeUndefined();
    expect(modelImage('skoda', 'kushaq')).toBeUndefined();
    expect(modelImage('skoda', 'kushaq', 'monte-carlo')).toBeUndefined();
    expect(heroImage('skoda-kushaq')).toBeUndefined();
  });
});
