import { APP_DATA } from './data.ts';
import type { Mid, Period, Vehicle } from './schema.ts';
import { type Brand, type CarSelection, type Cluster, OTHER_MODEL, OTHER_VARIANT } from './types.ts';

export const BRAND_OPTIONS: readonly { id: Brand; label: string }[] = [
  { id: 'skoda', label: 'Škoda' },
  { id: 'volkswagen', label: 'Volkswagen' },
];

const WORD_OVERRIDES: Record<string, string> = { rs: 'RS', gti: 'GTI', tsi: 'TSI', dsg: 'DSG', lk: 'L&K' };

/** `monte-carlo` → `Monte Carlo`, `octavia-rs` → `Octavia RS`. */
export function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => WORD_OVERRIDES[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const brandLabel = (brand: Brand): string => BRAND_OPTIONS.find((b) => b.id === brand)?.label ?? brand;

export interface ModelOption {
  id: string;
  label: string;
}

export function modelsFor(brand: Brand): ModelOption[] {
  const ids = [...new Set(APP_DATA.vehicles.filter((v) => v.brand === brand).map((v) => v.model))];
  return ids.map((id) => ({ id, label: titleCase(id) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Label of the "Other model" choice. */
export const OTHER_MODEL_LABEL = 'Other model';

/** The models to pick from on screen 1: every listed model, then "Other model" for any other car of the brand. */
export function modelChoicesFor(brand: Brand): ModelOption[] {
  return [...modelsFor(brand), { id: OTHER_MODEL, label: OTHER_MODEL_LABEL }];
}

/** A model's name on screen: `Octavia RS`, or `Other model`. */
export const modelLabel = (model: string): string =>
  model === OTHER_MODEL ? OTHER_MODEL_LABEL : titleCase(model);

/** The model is one the user can pick for this brand (a listed model or "Other model"). */
export const isModelChoice = (brand: Brand, model: string): boolean =>
  model === OTHER_MODEL || modelsFor(brand).some((m) => m.id === model);

/** The platform tag the data gives this model (every variant of a model shares one), or undefined. */
export function platformOfModel(brand: Brand, model: string): string | undefined {
  return (
    APP_DATA.vehicles.find((v) => v.brand === brand && v.model === model && v.platform)?.platform ?? undefined
  );
}

export function findVehicle(sel: Pick<CarSelection, 'brand' | 'model' | 'variant'>): Vehicle | null {
  if (sel.variant === OTHER_VARIANT) return null;
  return (
    APP_DATA.vehicles.find(
      (v) => v.brand === sel.brand && v.model === sel.model && v.variant === sel.variant,
    ) ?? null
  );
}

/** Which manufacture periods the evidence for this variant distinguishes. */
export function periodOfBuild(buildId: string): Period | null {
  if (/-(before)-(april|march)-2024$/.test(buildId)) return 'pre-2024-04';
  if (/-(post)-(april|march)-2024$/.test(buildId)) return 'post-2024-04';
  return null;
}

export function periodsOf(vehicle: Vehicle): Set<Period> {
  const out = new Set<Period>();
  for (const id of vehicle.listedBuilds) {
    const p = periodOfBuild(id);
    if (p) out.add(p);
  }
  return out;
}

/**
 * Build period the evidence is matched against, or null when it cannot be
 * settled (then nothing is treated as proven for this car).
 */
export function resolvePeriod(sel: CarSelection): Period | null {
  if (sel.year < 2024) return 'pre-2024-04';
  if (sel.year > 2024) return 'post-2024-04';
  if (sel.period2024) return sel.period2024;
  const vehicle = findVehicle(sel);
  const periods = vehicle ? [...periodsOf(vehicle)] : [];
  return periods.length === 1 ? (periods[0] ?? null) : null;
}

export function clusterOf(mid: Mid): Cluster | null {
  if (mid === 'Analogue') return 'analogue';
  if (mid === 'Digital') return 'digital';
  return null;
}

export const midOf = (cluster: Cluster): Mid => (cluster === 'analogue' ? 'Analogue' : 'Digital');

/**
 * Model year recorded until the car's VIN has been read. Only ever written into a backup when the VIN could not
 * be read, and never used to decide what a car can do.
 */
export const DEFAULT_YEAR = 2025;

/** The model a brand starts on when it is picked. */
export const DEFAULT_MODEL: Record<Brand, string> = { skoda: 'kushaq', volkswagen: 'taigun' };

/** A first selection for a model: brand and model only — everything else is read from the car on connect. */
export function defaultSelection(brand: Brand = 'skoda', model = DEFAULT_MODEL[brand]): CarSelection {
  const models = modelsFor(brand);
  const chosen = model === OTHER_MODEL ? undefined : (models.find((m) => m.id === model) ?? models[0]);
  return {
    brand,
    model: chosen?.id ?? model,
    variant: OTHER_VARIANT,
    year: DEFAULT_YEAR,
    cluster: 'analogue',
  };
}

/** `Škoda Kushaq`, then `· 2023 · Digital cluster` for whatever the connected car reported. */
export function carSummary(sel: CarSelection): string {
  const name =
    sel.model === OTHER_MODEL
      ? `${brandLabel(sel.brand)} (other model)`
      : `${brandLabel(sel.brand)} ${titleCase(sel.model)}`;
  const d = sel.detected;
  const parts = [
    name,
    d?.modelYear ? String(d.modelYear) : undefined,
    d?.cluster ? `${d.cluster === 'digital' ? 'Digital' : 'Analogue'} cluster` : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}
