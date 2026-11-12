import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppDataSchema } from './schema.ts';

const raw: unknown = JSON.parse(readFileSync(new URL('../../data/app-data.json', import.meta.url), 'utf8'));

describe('bundled app-data.json contract', () => {
  it('matches the schema (rerun `node scripts/build-data.mjs` after changing data/source)', () => {
    const result = AppDataSchema.safeParse(raw);
    if (!result.success)
      throw new Error(
        result.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('\n'),
      );
    expect(result.success).toBe(true);
  });

  it('carries no provenance paths or legacy project names to the browser', () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/docs\/reports/);
    expect(text).not.toMatch(/vagcoder|carpulse/i);
    expect(text).not.toMatch(/MEXK[A-Z0-9]{13}/);
  });

  it('only ships recipes that a feature references', () => {
    const data = AppDataSchema.parse(raw);
    const referenced = new Set(
      Object.values(data.features)
        .flatMap((f) => [f.recipeId, ...Object.values(f.recipeByPlatform)])
        .filter(Boolean),
    );
    expect(new Set(Object.keys(data.recipes))).toEqual(referenced);
  });
});
