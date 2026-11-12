import { describe, expect, it, vi } from 'vitest';
import { modelImage, resolveEdition } from './car-images.ts';

vi.mock('../data/car-images.json', () => ({
  default: {
    'skoda-kushaq': {
      icon: '/cars/icons/skoda-kushaq.webp',
      editions: {
        'monte-carlo': '/cars/skoda-kushaq/monte-carlo.webp',
        sportline: '/cars/skoda-kushaq/sportline.webp',
      },
    },
    'volkswagen-taigun': {
      icon: '/cars/icons/volkswagen-taigun.webp',
      editions: {
        gt: '/cars/volkswagen-taigun/gt.webp',
        'gt-line': '/cars/volkswagen-taigun/gt-line.webp',
        'gt-plus': '/cars/volkswagen-taigun/gt-plus.webp',
      },
    },
    'skoda-kylaq': { icon: '/cars/icons/skoda-kylaq.webp' },
  },
}));

describe('resolveEdition — which edition a trim or listing slug names', () => {
  const editions = ['gt', 'gt-line', 'gt-plus', 'monte-carlo'];

  it.each([
    ['monte-carlo', 'monte-carlo'],
    ['monte-carlo-manufactured-post-april', 'monte-carlo'],
    ['gt-line-with-digital-mid', 'gt-line'],
    ['gt-manufactured-before-april', 'gt'],
    ['gt-plus-sport', 'gt-plus'],
    ['GT-Line', 'gt-line'],
  ])('%s → %s (the longest matching edition wins)', (slug, edition) => {
    expect(resolveEdition(editions, slug)).toBe(edition);
  });

  it.each(['highline', 'gtx', 'monte', 'sport', '', undefined])('%s names no edition', (slug) => {
    expect(resolveEdition(editions, slug)).toBeUndefined();
  });
});

describe('modelImage — one picture per model, the edition’s once it is known', () => {
  it("shows the model's picture when the edition is unknown", () => {
    expect(modelImage('skoda', 'kushaq')).toBe('/cars/icons/skoda-kushaq.webp');
  });

  it("shows the edition's picture for its trim, listing or edition id", () => {
    expect(modelImage('skoda', 'kushaq', 'monte-carlo')).toBe('/cars/skoda-kushaq/monte-carlo.webp');
    expect(modelImage('skoda', 'kushaq', 'monte-carlo-manufactured-post-april')).toBe(
      '/cars/skoda-kushaq/monte-carlo.webp',
    );
    expect(modelImage('skoda', 'kushaq', 'skoda-kushaq-monte-carlo-manufactured-post-april')).toBe(
      '/cars/skoda-kushaq/monte-carlo.webp',
    );
    expect(modelImage('volkswagen', 'taigun', 'gt-line-with-digital-mid')).toBe(
      '/cars/volkswagen-taigun/gt-line.webp',
    );
    expect(modelImage('volkswagen', 'taigun', 'gt-plus-sport')).toBe('/cars/volkswagen-taigun/gt-plus.webp');
  });

  it("falls back to the model's picture for an edition without its own", () => {
    expect(modelImage('skoda', 'kushaq', 'prestige')).toBe('/cars/icons/skoda-kushaq.webp');
    expect(modelImage('volkswagen', 'taigun', 'highline-plus')).toBe('/cars/icons/volkswagen-taigun.webp');
    expect(modelImage('skoda', 'kylaq', 'signature')).toBe('/cars/icons/skoda-kylaq.webp');
  });

  it('has nothing for a model without pictures', () => {
    expect(modelImage('skoda', 'other')).toBeUndefined();
    expect(modelImage('skoda', 'other', 'monte-carlo')).toBeUndefined();
  });
});
