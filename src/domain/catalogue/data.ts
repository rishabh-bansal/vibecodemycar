import { z } from 'zod';
import { familyOfModel, type PlatformFamily } from '../catalog/platform.ts';
import { normalizeFeature } from './normalize.ts';
import { withAppCopy } from './status.ts';
import { type CatalogueFeature, type CatalogueModel, GROUP_IDS, type RawModel } from './types.ts';

const RawFeatureSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  group: z.enum(GROUP_IDS),
  category: z.string(),
  image: z.string().min(1).optional(),
  intro: z.string(),
  Functions: z.array(z.string()),
  Requirements: z.array(z.string()),
  Attention: z.array(z.string()),
  'In-Car procedure': z.array(z.string()),
  Notes: z.array(z.string()),
});

export const CatalogueFileSchema = z.object({
  schema: z.literal('obdcraft.catalogue/1'),
  models: z.array(
    z.object({
      make: z.enum(['skoda', 'volkswagen']),
      model: z.string().min(1),
      title: z.string().min(1),
      features: z.array(RawFeatureSchema).min(1),
    }),
  ),
});

/** The 8 India models, in display order. Anything else in the source folders is ignored. */
export const MODEL_ORDER: readonly string[] = [
  'skoda/kushaq',
  'skoda/slavia',
  'skoda/kylaq',
  'skoda/kodiaq',
  'skoda/superb',
  'volkswagen/taigun',
  'volkswagen/virtus',
  'volkswagen/tiguan',
];

/** Raw file → ordered, normalized models. Throws on a malformed file (caught at the screen boundary). */
export function buildCatalogue(file: unknown): CatalogueModel[] {
  const parsed = CatalogueFileSchema.parse(file);
  const byKey = new Map(parsed.models.map((m) => [`${m.make}/${m.model}`, m as RawModel]));
  return MODEL_ORDER.flatMap((key) => {
    const raw = byKey.get(key);
    if (!raw) return [];
    const features = raw.features.map(normalizeFeature);
    return [
      {
        make: raw.make,
        model: raw.model,
        key: `${raw.make}-${raw.model}`,
        title: raw.title,
        features,
        unlocks: features.filter((f) => f.group !== 'service'),
        service: features.filter((f) => f.group === 'service'),
      },
    ];
  });
}

const withLists = (model: CatalogueModel, features: CatalogueFeature[]): CatalogueModel => ({
  ...model,
  features,
  unlocks: features.filter((f) => f.group !== 'service'),
  service: features.filter((f) => f.group === 'service'),
});

/**
 * The cards of every model of a family, the first card per slug kept: `first` models' cards come first (their
 * own text wins), then each sister's in display order.
 */
function familyCards(
  models: readonly CatalogueModel[],
  first: readonly CatalogueModel[],
): CatalogueFeature[] {
  const seen = new Set<string>();
  const out: CatalogueFeature[] = [];
  for (const m of [...first, ...models.filter((x) => !first.includes(x))]) {
    for (const f of m.features) {
      if (seen.has(f.slug)) continue;
      seen.add(f.slug);
      out.push(f);
    }
  }
  return out;
}

const familyOfCatalogue = (m: CatalogueModel): PlatformFamily | undefined => familyOfModel(m.make, m.model);

/**
 * Sister cars share their electrics, so each model's cards are the union across its platform family: its own
 * cards first, in its own order and with its own text, then every card a sister model lists that it does not,
 * with that sister's text (the first sister in display order). A model without a family keeps its own cards.
 */
export function withFamilyFeatures(models: readonly CatalogueModel[]): CatalogueModel[] {
  return models.map((m) => {
    const family = familyOfCatalogue(m);
    if (!family) return m;
    const sisters = models.filter((x) => familyOfCatalogue(x) === family);
    return withLists(m, familyCards(sisters, [m]));
  });
}

/**
 * The cards for a car with no catalogue of its own — an "Other model", or a listed model without a feature list
 * (Octavia RS, Tayron, Golf GTI): every card of its family, the same brand's models' text first. Undefined when
 * no model of the family has a catalogue.
 */
export function familyCatalogue(
  models: readonly CatalogueModel[],
  car: { make: 'skoda' | 'volkswagen'; model: string; title: string; family: PlatformFamily },
): CatalogueModel | undefined {
  const sisters = models.filter((x) => familyOfCatalogue(x) === car.family);
  if (!sisters.length) return undefined;
  const features = familyCards(
    sisters,
    sisters.filter((x) => x.make === car.make),
  );
  return withLists(
    {
      make: car.make,
      model: car.model,
      key: `${car.make}-${car.model}`,
      title: car.title,
      features,
      unlocks: [],
      service: [],
    },
    features,
  );
}

/**
 * The models as the app shows them: each card carries the app data's friendly name and description where
 * it has them (see `withAppCopy`); the catalogue's own text stays everywhere else.
 */
export function withAppCopyModels(models: readonly CatalogueModel[]): CatalogueModel[] {
  return models.map((m) => {
    const features = m.features.map((f) => withAppCopy(f));
    return {
      ...m,
      features,
      unlocks: features.filter((f) => f.group !== 'service'),
      service: features.filter((f) => f.group === 'service'),
    };
  });
}

/**
 * The model with each card's copy taken from the app feature `idOf` names (the one codable on the user's
 * car), where that differs from the default join. Returns the same model when nothing changes.
 */
export function withCarCopy(
  model: CatalogueModel,
  idOf: (f: CatalogueFeature) => string | undefined,
): CatalogueModel {
  let changed = false;
  const features = model.features.map((f) => {
    const id = idOf(f);
    if (!id) return f;
    const next = withAppCopy(f, id);
    if (next.name === f.name && next.intro === f.intro) return f;
    changed = true;
    return next;
  });
  if (!changed) return model;
  return {
    ...model,
    features,
    unlocks: features.filter((f) => f.group !== 'service'),
    service: features.filter((f) => f.group === 'service'),
  };
}

/** Loaded lazily so the landing page never pays for ~290 KB of feature text. */
export async function loadCatalogue(): Promise<CatalogueModel[]> {
  const { default: file } = await import('../../data/catalogue.json');
  return withAppCopyModels(withFamilyFeatures(buildCatalogue(file)));
}
