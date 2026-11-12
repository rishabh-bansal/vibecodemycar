import type { Period } from './schema.ts';
import {
  type Brand,
  type CarSelection,
  type Cluster,
  type DetectedCar,
  OTHER_VARIANT,
  type PlatformKey,
} from './types.ts';
import { BRAND_OPTIONS, DEFAULT_YEAR, defaultSelection, findVehicle, isModelChoice } from './vehicles.ts';

const PERIODS: readonly Period[] = ['pre-2024-04', 'post-2024-04'];
const isCluster = (v: unknown): v is Cluster => v === 'analogue' || v === 'digital';
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
/** Families a body computer part can name (src/domain/catalog/platform.ts). */
const isPlatform = (v: unknown): v is PlatformKey => v === 'MQB-A0-IN' || v === 'MQB' || v === 'PQ';
/** The range a backup accepts (src/domain/backups/schema.ts). */
const plausibleYear = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 1990 && (v as number) <= 2100;

function asDetected(raw: unknown): DetectedCar | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: DetectedCar = {
    ...(isCluster(r.cluster) ? { cluster: r.cluster } : {}),
    ...(text(r.clusterPart) ? { clusterPart: r.clusterPart } : {}),
    ...(text(r.clusterDataset) ? { clusterDataset: r.clusterDataset } : {}),
    ...(plausibleYear(r.modelYear) ? { modelYear: r.modelYear } : {}),
    ...(text(r.bcmPart) ? { bcmPart: r.bcmPart } : {}),
    ...(isPlatform(r.platform) ? { platform: r.platform } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Persisted selections are untrusted: the data set may have changed since they were saved, and earlier versions
 * stored more (variant, year, cluster, build period — all asked on screen 1 then). A plain validator (not zod):
 * this runs on the landing page, which should not ship a schema library.
 *
 * Brand and model decide (a listed model or "Other model"); without a real one the default car is used. Every other field is kept only when it is
 * well-formed and still names something real, and is otherwise dropped on its own — an old or damaged detail
 * never costs the user their car. Unknown keys are dropped.
 */
export function sanitizeSelection(raw: unknown): CarSelection {
  if (!raw || typeof raw !== 'object') return defaultSelection();
  const r = raw as Record<string, unknown>;
  if (r.brand !== 'skoda' && r.brand !== 'volkswagen') return defaultSelection();
  if (!text(r.model) || !isModelChoice(r.brand, r.model)) return defaultSelection();
  const base = defaultSelection(r.brand, r.model);
  const variant =
    text(r.variant) && findVehicle({ brand: base.brand, model: base.model, variant: r.variant })
      ? r.variant
      : OTHER_VARIANT;
  const detected = asDetected(r.detected);
  const year = detected?.modelYear ?? (plausibleYear(r.year) ? r.year : DEFAULT_YEAR);
  const cluster = detected?.cluster ?? (isCluster(r.cluster) ? r.cluster : base.cluster);
  const period =
    variant !== OTHER_VARIANT && year === 2024 && PERIODS.includes(r.period2024 as Period)
      ? (r.period2024 as Period)
      : undefined;
  return {
    ...base,
    variant,
    year,
    cluster,
    ...(period ? { period2024: period } : {}),
    ...(detected ? { detected } : {}),
  };
}

/** A different brand or model is a different car: it starts from brand and model alone. */
export function withBrand(sel: CarSelection, brand: Brand): CarSelection {
  if (!BRAND_OPTIONS.some((b) => b.id === brand)) return sel;
  return defaultSelection(brand);
}

export function withModel(sel: CarSelection, model: string): CarSelection {
  if (!isModelChoice(sel.brand, model)) return sel;
  return defaultSelection(sel.brand, model);
}

/**
 * What the connected car reported replaces whatever was known before: the cluster and model year it gave are
 * the ones every later backup records.
 */
export function withDetected(sel: CarSelection, detected: DetectedCar): CarSelection {
  const year = detected.modelYear ?? sel.year;
  const { period2024: _dropped, detected: _old, ...rest } = sel;
  return {
    ...rest,
    year,
    cluster: detected.cluster ?? sel.cluster,
    ...(sel.period2024 && year === 2024 ? { period2024: sel.period2024 } : {}),
    ...(Object.keys(detected).length > 0 ? { detected } : {}),
  };
}
