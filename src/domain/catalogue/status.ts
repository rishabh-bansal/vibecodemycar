import { NOT_AVAILABLE_LABEL } from '../catalog/copy.ts';
import { APP_DATA } from '../catalog/data.ts';
import { featureDescription, featureDisplayName } from '../catalog/features.ts';
import type { FeatureItem } from '../catalog/types.ts';
import type { CatalogueFeature, CatalogueModel } from './types.ts';

/**
 * Old catalogue slug → app feature id, for the 59 features that predate the catalogue map. The data
 * pipeline now builds one app feature per catalogue slug (feature id = slug, recipe per platform), so the
 * slug itself is tried first; these joins only keep the older ids — and the backups that name them —
 * resolving where the slug has no feature of its own.
 */
export const CATALOGUE_ALIASES: Readonly<Record<string, string>> = {
  'gauge-test-needle-sweep': 'instrument-cluster-needle-sweep',
  'comfort-turn-signals': 'comfort-lane-change-indicator-5-flashes',
  'speed-warning-for-india': '80kmph-and-120kmph-speed-chime-warning',
  'seat-belt-warning': 'seat-belt-warning-disable',
  // Verified against each catalogue entry's own description — same function, not a name guess.
  'auto-folding-mirrors': 'auto-fold-orvms-on-long-press-of-lock-button',
  'lock-unlock-acoustic-confirmation': 'acoustic-confirmation-lock-unlock-sound',
  'anti-theft-alarm-system': 'anti-theft-alarm',
  'cornering-lights': 'cornering-lights-via-front-fog-lights',
  'drl-off-with-handbrake': 'turning-off-drl-using-hedlamp-control-switch-or-handbrake',
  'teardrop-wiping': 'tear-drop-wiping',
  'pulsation-of-start-button': 'engine-start-stop-button-pulsation',
  'hill-hold-assist': 'hill-hold-control',
  'emergency-braking-lights': 'emergency-stop-signal-flashing-panic-braking-lights',
  'oil-temperature-display': 'engine-oil-temperature-in-mid',
  'multimedia-startup-logo': 'change-startup-logo-of-infotainment-screen',
  'offroad-information-screen': 'display-offroad-menu-on-infotainment',
  'easy-entry': 'easy-convenient-entry-and-exit-for-driver-seat',
  'easy-entry-for-passenger': 'easy-convenient-entry-and-exit-for-driver-and-passenger-seats',
  'auto-unlock-with-ignition': 'disable-automatic-door-unlock-on-key-removal',
  'central-lock-with-ignition': 'turn-onoff-central-locking-using-remote-key-when-engine-ignition-on',
  'turn-signals-with-brake-lights': 'blink-tail-lamp-with-indicator',
  'fog-lights-with-high-beam': 'front-fog-lights-on-flash-along-with-headlights',
  'brake-lights-when-trunk-open': 'auto-turn-on-brake-light-when-boot-is-opened',
  'drl-settings-in-multimedia': 'drl-onoff-control-in-infotainment-settings',
  // Verified against each catalogue entry's own intro — the same feature under another vendor's name.
  // (us-style-turn-lights is front markers and front-pace-car-indicators is an alternation pattern —
  // deliberately not joined: neither is the tail-lamp turn feature.)
  'fan-level-display-when-auto': 'display-automatic-climate-control-fan-blower-speed-in-ac-auto-mode',
  'electronic-differential-lock-interaction':
    'improve-torque-vectoring-with-xds-expanded-electronic-differential-lock',
  'headlight-notification': 'disable-please-switch-on-the-lights-popup',
  'refuel-quantity-in-dashboard': 'display-refuel-quantity-in-mid',
  'scandinavian-drls': 'scandinavian-rear-drl',
  'speedometer-scale-range': 'top-speed-display-on-speedometer-as-280kmph',
  'engine-speed-rpm-in-dashboard': 'display-of-rpm-bar-tachometer-in-virtual-cockpit',
  'interior-light-fading': 'interior-light-fadein-fade-out-function-theatre-dimming-effect',
  'throttle-pedal-response': 'enhanced-throttle-response',
  'increased-engine-responsiveness': 'enhanced-throttle-response',
  'air-recirculation-memory': 'ac-recirculation-memory',
  'steering-angle-display': 'display-wheel-angle-on-mid',
};

/** What to show for a catalogue feature. Never invented: it comes from the app data or it is "not codable". */
export type CatalogueStatus =
  | { kind: 'codable'; tier: 'tested' | 'experimental'; label: string; item: FeatureItem }
  /** No bytes to write for this car (no recipe for its platform, or no byte map): browsable, not codable. */
  | { kind: 'not-codable'; label: typeof NOT_AVAILABLE_LABEL }
  /** Browsing a model other than the one the user set up — a navigation hint ("set up this car"), not a lock. */
  | { kind: 'other-car'; label: typeof OTHER_CAR_LABEL };

export const OTHER_CAR_LABEL = 'SELECT THIS CAR TO CHECK';

/**
 * App feature ids a catalogue slug can join, in order: the slug itself (feature id = slug), the legacy
 * feature the pipeline joined it to (`aliasOf`), then the hand-written alias.
 */
export function appFeatureIds(slug: string): string[] {
  const ids = [slug, APP_DATA.features[slug]?.aliasOf, CATALOGUE_ALIASES[slug]];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/**
 * The card with the app data's friendly copy applied: the first joined app feature that carries a friendly
 * name (or description) supplies it; the catalogue's own name and intro stay where there is none.
 * `preferId` (the joined feature that is codable on the user's car) is tried first, so a card joined to
 * several app features describes the one this car would actually get. Re-applying is safe: it always
 * starts from the catalogue's own text.
 */
export function withAppCopy(feature: CatalogueFeature, preferId?: string): CatalogueFeature {
  const base = feature.original ? { ...feature, ...feature.original } : feature;
  const joined = appFeatureIds(base.slug);
  const ids = preferId && joined.includes(preferId) ? [preferId, ...joined] : joined;
  const named = ids.find((id) => featureDisplayName(id, '') !== '');
  const described = ids.map(featureDescription).find((d) => d !== undefined);
  if (!named && !described) return base;
  return {
    ...base,
    original: { name: base.name, intro: base.intro },
    ...(named ? { name: featureDisplayName(named, base.name) } : {}),
    ...(described ? { intro: described } : {}),
  };
}

/**
 * The reverse of `appFeatureIds`: the catalogue slug whose card opens an app feature id (a backup names the
 * feature it changed, possibly by an older id). An id with no catalogue join is returned as it is.
 */
export function catalogueSlugFor(featureId: string): string {
  const pipeline = Object.entries(APP_DATA.features).find(([, f]) => f.aliasOf === featureId)?.[0];
  const alias = Object.entries(CATALOGUE_ALIASES).find(([, id]) => id === featureId)?.[0];
  return pipeline ?? alias ?? featureId;
}

const RANK = { tested: 0, experimental: 1, unavailable: 2 } as const;

/** The joined item for a catalogue slug: the best-evidenced one (tested, then codable), else the first present. */
function joinedItem(slug: string, items: ReadonlyMap<string, FeatureItem>): FeatureItem | undefined {
  const found = appFeatureIds(slug)
    .map((id) => items.get(id))
    .filter((i): i is FeatureItem => !!i);
  return [...found].sort((a, b) => RANK[a.tier] - RANK[b.tier])[0];
}

export function statusFor(
  feature: CatalogueFeature,
  ctx: { isUsersCar: boolean; items: ReadonlyMap<string, FeatureItem> },
): CatalogueStatus {
  if (!ctx.isUsersCar) return { kind: 'other-car', label: OTHER_CAR_LABEL };
  const joined = joinedItem(feature.slug, ctx.items);
  // Codable whenever the app has bytes to write for this car; "not codable" only when it has none.
  if (!joined || joined.tier === 'unavailable') return { kind: 'not-codable', label: NOT_AVAILABLE_LABEL };
  return { kind: 'codable', tier: joined.tier, label: joined.statusLabel, item: joined };
}

/** Config: preferred "most loved" features, in order. */
export const HERO_SLUGS: readonly string[] = ['comfort-turn-signals', 'gauge-test-needle-sweep'];

/**
 * The hero card: first HERO_SLUGS entry this car has that is TESTED; else the first TESTED unlock; else none.
 * A feature with a legal warning is never the hero.
 */
export function pickHero(
  model: CatalogueModel,
  statusOf: (f: CatalogueFeature) => CatalogueStatus,
): CatalogueFeature | undefined {
  const eligible = (f: CatalogueFeature): boolean => {
    const s = statusOf(f);
    return !f.legal && s.kind === 'codable' && s.tier === 'tested';
  };
  for (const slug of HERO_SLUGS) {
    const f = model.unlocks.find((x) => x.slug === slug);
    if (f && eligible(f)) return f;
  }
  return model.unlocks.find(eligible);
}
