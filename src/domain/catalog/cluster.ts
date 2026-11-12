import type { CarReader, ModuleAddress } from '../coding/types.ts';
import { APP_DATA } from './data.ts';
import {
  familyOfBcmPart,
  familyOfKey,
  familyOfModel,
  listedModels,
  type PlatformFamily,
} from './platform.ts';
import type { Brand, CarSelection, Cluster, DetectedCar } from './types.ts';

/**
 * Instrument cluster: the one car detail some features depend on. It is never asked — the cluster's own
 * identity is read when the car connects, and the features that need one type resolve from it.
 */

/** The instrument cluster (unit 17), which also serves the VIN on these cars. */
export const CLUSTER_MODULE: ModuleAddress = { request: '714', response: '77E' };

/** The body computer (unit 09): its part number names the car's platform family. */
export const BCM_MODULE: ModuleAddress = { request: '70E', response: '778' };

/**
 * Features whose catalogue entry for this model names the cluster type they need — "must be equipped with a
 * digital dashboard / virtual cockpit" (digital) or "not compatible with digital dashboard" (analogue). Keyed
 * by app feature id: the catalogue slug and every app feature it joins. Per model, as each model's own
 * catalogue states it; `cluster.test.ts` re-derives this table from src/data/catalogue.json.
 */
export const CLUSTER_REQUIREMENTS: Readonly<Record<string, Readonly<Record<string, Cluster>>>> = {
  'skoda-slavia': {
    'gauge-test-needle-sweep': 'analogue',
    'instrument-cluster-needle-sweep': 'analogue',
  },
  'skoda-kylaq': {
    'speedometer-scale-range': 'digital',
    'top-speed-display-on-speedometer-as-280kmph': 'digital',
    'dashboard-startup-logo': 'digital',
    'engine-speed-rpm-in-dashboard': 'digital',
    'display-of-rpm-bar-tachometer-in-virtual-cockpit': 'digital',
  },
  'skoda-superb': {
    'speedometer-scale-range': 'digital',
    'top-speed-display-on-speedometer-as-280kmph': 'digital',
    'transmission-temperature': 'digital',
  },
  'volkswagen-virtus': {
    'efficiency-assist-display': 'digital',
  },
};

/**
 * The cluster type a feature needs on this car, or undefined when it works with either. Per platform family, like
 * the features themselves: a model whose own catalogue lists the feature says what it needs (its word wins);
 * otherwise the sister models of its family that list it decide, and only when they all name the same type —
 * sisters that disagree, or one that lists it with no requirement, leave it open to either cluster. `family`
 * defaults to the model's own (pass it for an "Other model").
 */
export function clusterRequirement(
  brand: Brand,
  model: string,
  featureId: string,
  family: PlatformFamily | undefined = familyOfModel(brand, model),
): Cluster | undefined {
  const key = `${brand}-${model}`;
  const feature = APP_DATA.features[featureId];
  const listed = feature ? listedModels(feature) : new Set<string>();
  if (!feature || listed.has(key) || !family) return CLUSTER_REQUIREMENTS[key]?.[featureId];
  const sisters = [...listed].filter((m) => familyOfKey(m) === family);
  const needs = new Set(sisters.map((m) => CLUSTER_REQUIREMENTS[m]?.[featureId]));
  return needs.size === 1 ? [...needs][0] : undefined;
}

/** The cluster type the connected car reported, or null while it is not known. */
export const knownCluster = (sel: Pick<CarSelection, 'detected'>): Cluster | null =>
  sel.detected?.cluster ?? null;

/**
 * Cluster identities read on real cars, and the type each one is. Matched on the part number with every
 * non-alphanumeric character removed; a part with a suffix letter matches its base number.
 */
export const KNOWN_CLUSTERS: readonly { part: string; dataset?: string; cluster: Cluster }[] = [
  // Kushaq Monte Carlo, digital cockpit: 6JM920310 / EV_DashBoardJCIMQBAB (docs/research/REMAINING_FEATURES.md).
  { part: '6JM920310', dataset: 'EV_DashBoardJCIMQBAB', cluster: 'digital' },
];

const normalise = (s: string | undefined): string => (s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

/** The cluster type for a read identity, or undefined when it is not one we know. */
export function classifyCluster(identity: { part?: string; dataset?: string }): Cluster | undefined {
  const part = normalise(identity.part);
  if (!part) return undefined;
  return KNOWN_CLUSTERS.find((k) => part.startsWith(normalise(k.part)))?.cluster;
}

/** VIN position 10 → model year, for the 2010–2039 cycle. */
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

/** The model year the VIN encodes, or undefined when it can't be read or is not plausible yet. */
export function modelYearOfVin(vin: string | undefined, now = new Date()): number | undefined {
  const code = vin?.trim().toUpperCase()[9];
  if (!vin || vin.trim().length !== 17 || !code) return undefined;
  const i = YEAR_CODES.indexOf(code);
  if (i < 0) return undefined;
  const year = 2010 + i;
  return year <= now.getFullYear() + 1 ? year : undefined;
}

/** Upper-case hex → printable ASCII, trimmed; '' when it is not text. */
function asText(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes
    .map((b) => Number.parseInt(b, 16))
    .filter((c) => c >= 0x20 && c < 0x7f)
    .map((c) => String.fromCharCode(c))
    .join('')
    .trim();
}

async function readText(reader: CarReader, did: string, module: ModuleAddress): Promise<string | undefined> {
  try {
    const r = await reader.readDid(module, did);
    return r.kind === 'ok' ? asText(r.bytes) || undefined : undefined;
  } catch {
    return undefined;
  }
}

type ScopedLink = CarReader & {
  withReads?: <T>(m: ModuleAddress, work: (r: CarReader) => Promise<T>) => Promise<T>;
};

/** One module's reads, scoped to it when the link scopes reads; never throws (nothing read → `{}`). */
async function readsOf<T extends object>(
  link: ScopedLink,
  module: ModuleAddress,
  work: (reader: CarReader) => Promise<T>,
): Promise<Partial<T>> {
  try {
    return link.withReads ? await link.withReads(module, work) : await work(link);
  } catch {
    return {};
  }
}

/**
 * Reads what the car says about itself: the model year from the VIN already read, the instrument cluster's
 * identity (part number and dataset name) and the body computer's part number, which names the platform family
 * (three plain reads, nothing is written). Never throws: anything it could not read is left out.
 */
export async function detectCar(link: ScopedLink, vin: string | undefined): Promise<DetectedCar> {
  const identity = await readsOf(link, CLUSTER_MODULE, async (reader) => ({
    part: await readText(reader, 'F187', CLUSTER_MODULE),
    dataset: await readText(reader, 'F19E', CLUSTER_MODULE),
  }));
  const bcm = await readsOf(link, BCM_MODULE, async (reader) => ({
    part: await readText(reader, 'F187', BCM_MODULE),
  }));
  const cluster = classifyCluster(identity);
  const platform = familyOfBcmPart(bcm.part);
  const modelYear = modelYearOfVin(vin);
  return {
    ...(cluster ? { cluster } : {}),
    ...(identity.part ? { clusterPart: identity.part } : {}),
    ...(identity.dataset ? { clusterDataset: identity.dataset } : {}),
    ...(modelYear ? { modelYear } : {}),
    ...(bcm.part ? { bcmPart: bcm.part } : {}),
    ...(platform ? { platform } : {}),
  };
}
