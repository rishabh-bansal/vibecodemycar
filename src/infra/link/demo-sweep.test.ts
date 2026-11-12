/**
 * The demo flow for the whole catalogue: on every listed vehicle and cluster, every setting the app offers runs
 * apply → backup → write → read-back on the demo car, and the backup it made restores. Covers every recipe kind
 * the catalogue ships (field, scalar, ops, dataset, alt variant selection, multi-part groups).
 */
import { describe, expect, it } from 'vitest';
import type { BackupRecord } from '../../domain/backups/schema.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import { featuresFor } from '../../domain/catalog/features.ts';
import type { CarSelection, FeatureItem } from '../../domain/catalog/types.ts';
import { runSession } from '../../domain/coding/run.ts';
import type { CarLink, CodingEvent, CodingRequest } from '../../domain/coding/types.ts';
import { createDemoCar, createDemoCarFromBackup } from './demo.ts';

const instant = async () => {};
const quick = { sleep: instant, latencyMs: 0, pendingMs: 0 };

const CARS: CarSelection[] = APP_DATA.vehicles.flatMap((v) =>
  (['digital', 'analogue'] as const).map(
    (cluster): CarSelection => ({ brand: v.brand, model: v.model, variant: v.variant, year: 2023, cluster }),
  ),
);

async function session(req: CodingRequest, link: CarLink, feature: FeatureItem) {
  const saved: BackupRecord[] = [];
  let last: CodingEvent | undefined;
  for await (const e of runSession(req, {
    link,
    signal: new AbortController().signal,
    sleep: instant,
    readbackDelayMs: 0,
    featureFor: () => feature,
    backups: {
      save: async (b) => void saved.push(structuredClone(b)),
      update: async (id, patch) => {
        const i = saved.findIndex((b) => b.id === id);
        if (i >= 0) saved[i] = { ...(saved[i] as BackupRecord), ...patch };
      },
    },
  }))
    last = e;
  return { last, record: saved[0] };
}

const ok = (e: CodingEvent | undefined): boolean =>
  e?.type === 'outcome' && (e.outcome === 'verified' || /already set/.test(e.phase ?? ''));

describe('demo flow across the catalogue', () => {
  it('every offered setting applies and restores on the demo car', async () => {
    const failures: string[] = [];
    // The engine's behaviour depends on the recipe and setting, not on which car listed them: run each once.
    const seen = new Set<string>();
    let tried = 0;
    for (const car of CARS) {
      for (const feature of featuresFor(car)) {
        if (!feature.recipeId || feature.reason) continue;
        // A scalar also takes a free value (`value:<n>`): try its range ends.
        const free = feature.scalar
          ? [feature.scalar.min, feature.scalar.max].map((n) => ({ id: `value:${n}` }))
          : [];
        for (const setting of [...feature.settings, ...free]) {
          const key = `${feature.recipeId}|${setting.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tried++;
          const where = `${car.model}/${car.variant}/${car.cluster} ${feature.id} ${setting.id}`;
          try {
            const applied = await session(
              { kind: 'apply', car, feature, settingId: setting.id },
              createDemoCar(feature, setting.id, quick),
              feature,
            );
            if (!ok(applied.last)) {
              failures.push(`${where} apply: ${JSON.stringify(applied.last)}`);
              continue;
            }
            if (!applied.record) continue;
            const restored = await session(
              { kind: 'restore', backup: applied.record },
              createDemoCarFromBackup(applied.record, quick),
              feature,
            );
            if (restored.last?.type !== 'outcome' || restored.last.outcome !== 'verified')
              failures.push(`${where} restore: ${JSON.stringify(restored.last)}`);
          } catch (e) {
            failures.push(`${where} threw: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(200);
    expect(failures).toEqual([]);
  }, 120_000);
});
