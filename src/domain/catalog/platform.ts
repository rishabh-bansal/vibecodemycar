import { APP_DATA, platformKeyOf } from './data.ts';
import { type Brand, type CarSelection, OTHER_MODEL, type PlatformKey } from './types.ts';
import { titleCase } from './vehicles.ts';

/**
 * Platform families. The India 2.0 cars — Kushaq, Slavia, Kylaq, Taigun and Virtus — are all MQB-A0-IN and share
 * most of their electrics (the same 2Q0 937 08x body computer family, the same instrument clusters); Kodiaq,
 * Superb, Octavia, Tiguan, Tayron and Golf are the larger MQB cars (MQB-37 and MQB-B in the data). A feature one
 * car of a family can take, every car of that family can take: recipes are keyed by family, and the engine still
 * picks the exact variant for each module from its own part number when it writes.
 */
export type PlatformFamily = PlatformKey;

/**
 * The family of a vehicle platform tag ('MQB-A0-IN', 'MQB-37', 'MQB-B', 'PQ26', …); null when not one we know. The
 * one mapping from platform to family (it lives with the data so the data module needs nothing from here).
 */
export const platformFamily: (platform: string | null | undefined) => PlatformFamily | null = platformKeyOf;

/** The family most Škoda and Volkswagen cars sold in India are built on: what an unknown car starts from. */
export const DEFAULT_FAMILY: PlatformFamily = 'MQB-A0-IN';

export const isOtherModel = (model: string): boolean => model === OTHER_MODEL;

/** `skoda-kushaq` → its family, for every model the app data names. */
const MODEL_FAMILY: ReadonlyMap<string, PlatformFamily> = new Map(
  APP_DATA.vehicles.flatMap((v) => {
    const family = platformFamily(v.platform);
    return family ? [[`${v.brand}-${v.model}`, family] as const] : [];
  }),
);

/** The family of a model in the app data, or undefined (an "Other model", or a model without a platform tag). */
export const familyOfModel = (brand: Brand, model: string): PlatformFamily | undefined =>
  MODEL_FAMILY.get(`${brand}-${model}`);

/** {@link familyOfModel} by model key (`skoda-kushaq`). */
export const familyOfKey = (key: string): PlatformFamily | undefined => MODEL_FAMILY.get(key);

/** Every model (`brand-model`) of a family, both brands. */
export function familyModels(family: PlatformFamily): string[] {
  return [...MODEL_FAMILY].filter(([, f]) => f === family).map(([key]) => key);
}

/**
 * Body computer (unit 09) part-number prefixes and the family each belongs to. The BCM is the one module every
 * one of these cars has, and its F187 part number names the generation: 2Q0 937 08x is MQB-A0 (Kushaq, Taigun,
 * Slavia, Virtus, Kylaq, Polo), 5Q0 / 3Q0 937 08x and the later 5WA are the larger MQB cars.
 */
const BCM_FAMILIES: readonly { prefix: string; family: PlatformFamily }[] = [
  { prefix: '2Q0', family: 'MQB-A0-IN' },
  { prefix: '5Q0', family: 'MQB' },
  { prefix: '3Q0', family: 'MQB' },
  { prefix: '5WA', family: 'MQB' },
];

/** The family a body computer part number (F187 of unit 09, any spacing) belongs to; undefined when not known. */
export function familyOfBcmPart(part: string | undefined): PlatformFamily | undefined {
  const p = (part ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!p) return undefined;
  return BCM_FAMILIES.find((b) => p.startsWith(b.prefix))?.family;
}

/**
 * The family this car's features and recipes come from, and whether it is settled. A listed model is its own
 * family. An "Other model" takes the family the car's body computer reported on connect; before that (or when
 * the part is not one we know) it starts from {@link DEFAULT_FAMILY}, to be confirmed on connect.
 */
export function familyOf(sel: Pick<CarSelection, 'brand' | 'model' | 'detected'>): {
  family: PlatformFamily;
  confirmed: boolean;
} {
  const own = familyOfModel(sel.brand, sel.model);
  if (own) return { family: own, confirmed: true };
  const read = sel.detected?.platform;
  if (read) return { family: read, confirmed: true };
  return { family: DEFAULT_FAMILY, confirmed: false };
}

/** {@link familyOf}, the family alone. */
export const familyFor = (sel: Pick<CarSelection, 'brand' | 'model' | 'detected'>): PlatformFamily =>
  familyOf(sel).family;

const titleOf = (key: string): string => titleCase(key.replace(/^(skoda|volkswagen)-/, ''));

/** `Kushaq, Slavia, Kylaq, Taigun and Virtus` — the family's models in plain words. */
export function familyModelNames(family: PlatformFamily): string {
  const names = [...new Set(familyModels(family).map(titleOf))];
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The model (`brand-model`) a listing id names: a build id (`skoda-kushaq-monte-carlo-…`) or a model-level id
 * (`skoda-superb`). The longest known model wins (`skoda-octavia-rs` over a plain `skoda-octavia`); undefined for a
 * car the app does not list (older PQ cars such as the Rapid or Polo).
 */
const MODEL_KEYS = [...MODEL_FAMILY.keys()].sort((a, b) => b.length - a.length);
export function modelOfListing(id: string): string | undefined {
  return MODEL_KEYS.find((key) => id === key || id.startsWith(`${key}-`));
}

const LISTED_MODELS = new WeakMap<object, ReadonlySet<string>>();

/** The models (`brand-model`) whose own catalogue or build list names this feature. */
export function listedModels(feature: { listedOn: readonly string[] }): ReadonlySet<string> {
  let out = LISTED_MODELS.get(feature);
  if (!out) {
    out = new Set(feature.listedOn.map(modelOfListing).filter((m): m is string => !!m));
    LISTED_MODELS.set(feature, out);
  }
  return out;
}

/** The feature is listed on at least one model of this family — so every car of the family is offered it. */
export const listedInFamily = (feature: { listedOn: readonly string[] }, family: PlatformFamily): boolean =>
  [...listedModels(feature)].some((m) => MODEL_FAMILY.get(m) === family);
