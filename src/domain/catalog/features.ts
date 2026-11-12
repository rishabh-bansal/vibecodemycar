import { clusterRequirement, knownCluster } from './cluster.ts';
import { AVAILABLE_LABEL, CLUSTER_PENDING_LABEL, unavailableLabel } from './copy.ts';
import { APP_DATA } from './data.ts';
import { familyFor, listedInFamily, listedModels } from './platform.ts';
import type { DataFeature, Recipe, RecipeChoice } from './schema.ts';
import { boundProof, type CarContext, contextFor, supportFor } from './support.ts';
import type {
  CarSelection,
  Cluster,
  FeatureItem,
  FeatureRecord,
  FeatureSetting,
  PlatformKey,
  RecipeVariant,
  ScalarInput,
  StepRecipe,
  Tier,
  UnavailableReason,
} from './types.ts';

export type { ScalarInput } from './types.ts';

/** The feature's own record, for its friendly copy (displayName, description, settingLabels — all optional). */
const copyOf = (featureId: string): FeatureRecord | undefined => APP_DATA.features[featureId];

const nonEmpty = (text: string | undefined): string | undefined => {
  const t = text?.trim();
  return t ? t : undefined;
};

/** The name to show for an app feature id: its friendly name when the data has one, else `fallback`. */
export function featureDisplayName(featureId: string, fallback: string): string {
  return nonEmpty(copyOf(featureId)?.displayName) ?? fallback;
}

/** The feature's friendly one-line description, when the data has one. */
export function featureDescription(featureId: string): string | undefined {
  return nonEmpty(copyOf(featureId)?.description);
}

/** The friendly label for one setting of a feature, when the data has one. */
export function featureSettingLabel(featureId: string, settingId: string): string | undefined {
  const labels = copyOf(featureId)?.settingLabels;
  return labels && Object.hasOwn(labels, settingId) ? nonEmpty(labels[settingId]) : undefined;
}

/** Settings with the feature's own friendly labels applied where it has them. */
function withSettingLabels(featureId: string, settings: FeatureSetting[]): FeatureSetting[] {
  return settings.map((s) => {
    const label = featureSettingLabel(featureId, s.id);
    return label ? { ...s, label } : s;
  });
}

/** A catalogue entry for one car. (The contract's FeatureItem already carries the free-value range.) */
export type CodableItem = FeatureItem;

/**
 * Platform keys to try for this car: its platform family (src/domain/catalog/platform.ts). Recipes are keyed by
 * family — sister cars share them, and the engine picks each module's exact variant from its part number.
 */
export function platformsFor(sel: Pick<CarSelection, 'brand' | 'model' | 'detected'>): PlatformKey[] {
  return [familyFor(sel)];
}

/**
 * The recipe this feature writes on this car's platform. A feature with per-platform recipes resolves by the
 * car's platform (most specific key first); without a car it falls back to its default recipe.
 */
export function recipeIdFor(feature: DataFeature, sel?: CarSelection): string | undefined {
  const byPlatform = feature.recipeByPlatform ?? {};
  if (sel && Object.keys(byPlatform).length > 0) {
    for (const p of platformsFor(sel)) {
      const id = byPlatform[p];
      if (id) return id;
    }
    return undefined;
  }
  return feature.recipeId ?? undefined;
}

export function recipeOf(feature: DataFeature, sel?: CarSelection): Recipe | undefined {
  const id = recipeIdFor(feature, sel);
  return id ? APP_DATA.recipes[id] : undefined;
}

/**
 * The choices a recipe offers: top level (field, ops, dataset, scalar presets, group-level ids) or, for a
 * variant split, the first variant that declares any.
 */
export function choicesOf(recipe: Recipe): readonly RecipeChoice[] {
  if (recipe.choices?.length) return recipe.choices;
  return recipe.variants?.find((v) => v.choices?.length)?.choices ?? [];
}

type Encoded = StepRecipe | RecipeVariant;

/**
 * Whether the recipe carries bytes the engine can put on the wire. Structure (plus the pipeline's own
 * `executable: false` / `reason: 'no-bytes'` marker) only: a recipe is "not codable" when there is literally
 * nothing to write, never because of a policy flag.
 */
function hasBytes(r: Recipe | Encoded): boolean {
  if (r.executable === false) return false;
  switch (r.kind) {
    case 'field':
      return !!r.field && r.choices.length > 0;
    case 'scalar':
      return !!r.scalar;
    case 'ops':
      return r.choices.some((c) => c.ops.length > 0);
    case 'dataset':
      return r.choices.some((c) => !!c.payload);
    case 'alt':
      return r.variants.some((v) => hasBytes(v));
    case 'group':
      return r.steps.length > 0 && r.steps.every((s) => hasBytes(s));
    default:
      return false;
  }
}

/** The recipe has no byte-level write path — the only reason a mapped feature is not offered. */
export const isLocked = (recipe: Recipe): boolean => !hasBytes(recipe);

/** The recipe is written through a declared command sequence (or is a dataset, which must have one). */
export const needsSequence = (recipe: Recipe): boolean => !!recipe.sequence || recipe.kind === 'dataset';

const wireValue = (c: RecipeChoice): number | undefined => ('value' in c ? c.value : undefined);

const isToggle = (choices: readonly RecipeChoice[]): boolean =>
  choices.length === 2 && choices.some((c) => c.id === 'enabled') && choices.some((c) => c.id === 'disabled');

function labelChoice(recipe: Recipe, choice: RecipeChoice, toggle: boolean): string {
  if (toggle) return choice.id === 'enabled' ? 'On' : 'Off';
  if (/^\d+$/.test(choice.label) && /blink|flash/i.test(recipe.name)) return `${choice.label} blinks`;
  return choice.label.charAt(0).toUpperCase() + choice.label.slice(1);
}

/**
 * Every choice the recipe declares — toggles On first, otherwise in wire-value order when values exist — or,
 * when the feature carries its own display settings (catalogue map relabel/subset), those, in that order.
 */
export function settingsOf(
  recipe: Recipe,
  display?: readonly { id: string; label: string }[],
): FeatureSetting[] {
  const choices = choicesOf(recipe);
  if (display?.length) {
    const known = new Map(choices.map((c) => [c.id, c]));
    return display
      .filter((d) => known.has(d.id) || recipe.kind === 'group')
      .map((d) => {
        const v = known.get(d.id);
        const value = v ? wireValue(v) : undefined;
        return { id: d.id, label: d.label, ...(value !== undefined ? { value } : {}) };
      });
  }
  const toggle = isToggle(choices);
  const valued = choices.every((c) => wireValue(c) !== undefined);
  const ordered = toggle
    ? [...choices].sort((a, b) => Number(b.id === 'enabled') - Number(a.id === 'enabled'))
    : valued
      ? [...choices].sort((a, b) => (wireValue(a) ?? 0) - (wireValue(b) ?? 0))
      : [...choices];
  return ordered.map((c) => {
    const value = wireValue(c);
    return { id: c.id, label: labelChoice(recipe, c, toggle), ...(value !== undefined ? { value } : {}) };
  });
}

const round = (n: number): number => Number(n.toPrecision(12));

/** The free-value range of a scalar recipe (top level or its first scalar variant), else undefined. */
export function scalarOf(recipe: Recipe): ScalarInput | undefined {
  const s = recipe.scalar ?? recipe.variants?.find((v) => v.scalar)?.scalar;
  if (!s) return undefined;
  const bits = 8 * s.dataLength;
  const rawMin = s.signed ? -(2 ** (bits - 1)) : 0;
  const rawMax = s.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const a = round(rawMin * s.multiplier + s.offset);
  const b = round(rawMax * s.multiplier + s.offset);
  return {
    min: s.min ?? Math.min(a, b),
    max: s.max ?? Math.max(a, b),
    step: Math.abs(s.multiplier) || 1,
    ...(s.unit ? { unit: s.unit } : {}),
  };
}

const VALUE_PREFIX = 'value:';

export const isFreeValue = (settingId: string): boolean => settingId.startsWith(VALUE_PREFIX);

/** `value:<n>` for a free scalar value. */
export const freeValueSetting = (n: number): string => `${VALUE_PREFIX}${n}`;

/**
 * The physical value a `value:<n>` setting asks for, when it is a number inside the item's range and on its
 * step grid; undefined otherwise.
 */
export function parseFreeValue(item: Pick<CodableItem, 'scalar'>, settingId: string): number | undefined {
  if (!item.scalar || !isFreeValue(settingId)) return undefined;
  const text = settingId.slice(VALUE_PREFIX.length).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  const { min, max, step } = item.scalar;
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  const steps = (n - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6 ? n : undefined;
}

/** What to call a setting on screen: its label, or the free value with its unit. */
export function settingLabel(item: CodableItem, settingId: string): string | undefined {
  const preset = item.settings.find((s) => s.id === settingId)?.label;
  if (preset) return preset;
  const n = parseFreeValue(item, settingId);
  if (n === undefined) return undefined;
  return item.scalar?.unit ? `${n} ${item.scalar.unit}` : String(n);
}

/** Part numbers of the modules a recipe has live proof on (trusted app data); empty when never proven. */
export function provenPartsOf(recipeId: string): string[] {
  const parts = Object.values(APP_DATA.features)
    .filter((f) => f.recipeId === recipeId)
    .flatMap((f) => f.liveProof.map((p) => p.module.part));
  return [...new Set(parts)];
}

/**
 * Offered on this car: listed for its own model (any variant) or for any sister model of its platform family —
 * sister cars share their electrics, so what one can take every one can. Nothing is withheld for lack of
 * variant evidence.
 */
function listedForCar(feature: DataFeature, sel: CarSelection): boolean {
  return listedModels(feature).has(`${sel.brand}-${sel.model}`) || listedInFamily(feature, familyFor(sel));
}

/** The cluster type a feature needs on this car (its own model's word, else its family's): see cluster.ts. */
const clusterNeedOf = (sel: CarSelection, featureId: string): Cluster | undefined =>
  clusterRequirement(sel.brand, sel.model, featureId, familyFor(sel));

function unavailable(
  base: { id: string; name: string },
  reason: UnavailableReason,
  sel: CarSelection,
): CodableItem {
  return {
    ...base,
    tier: 'unavailable',
    reason,
    statusLabel: unavailableLabel(reason, sel.cluster),
    settings: [],
  };
}

function toItem(feature: DataFeature, ctx: CarContext, sel: CarSelection): CodableItem {
  const base = { id: feature.id, name: featureDisplayName(feature.id, feature.name) };
  const recipe = recipeOf(feature, sel);
  if (!recipe) return unavailable(base, 'not-mapped', sel);
  if (isLocked(recipe)) return unavailable(base, 'not-executable', sel);
  // A feature this model's catalogue ties to one cluster type: settled by the cluster the car reports on
  // connect; until then it stays on offer, marked as depending on the cluster.
  const needsCluster = clusterNeedOf(sel, feature.id);
  const cluster = knownCluster(sel);
  if (needsCluster && cluster && cluster !== needsCluster) return unavailable(base, 'wrong-cluster', sel);
  const pending = needsCluster && !cluster ? needsCluster : undefined;
  const support = supportFor(ctx, feature);
  // The tier only orders the list (and picks the hero); on screen every codable feature reads the same.
  const tier: Tier = support === 'live-verified' ? 'tested' : 'experimental';
  const scalar = scalarOf(recipe);
  const proof = boundProof(feature, ctx);
  return {
    ...base,
    tier,
    statusLabel: pending ? CLUSTER_PENDING_LABEL : AVAILABLE_LABEL,
    recipeId: recipe.id,
    settings: withSettingLabels(feature.id, settingsOf(recipe, feature.settings)),
    ...(scalar ? { scalar } : {}),
    ...(proof ? { proof } : {}),
    ...(pending ? { needsCluster: pending } : {}),
  };
}

/**
 * Why a feature this model offers is not available on the connected car because of its instrument cluster —
 * the cluster type it needs — or undefined when the cluster is not the reason.
 */
export function clusterMismatch(sel: CarSelection, featureId: string): Cluster | undefined {
  const needs = clusterNeedOf(sel, featureId);
  const cluster = knownCluster(sel);
  return needs && cluster && cluster !== needs ? needs : undefined;
}

const TIER_ORDER: Record<Tier, number> = { tested: 0, experimental: 1, unavailable: 2 };

/**
 * Everything the app can say about this car's hidden features, ordered as the list shows them: tested,
 * then experimental, then unavailable (no bytes to write for this platform).
 */
export function featuresFor(sel: CarSelection): CodableItem[] {
  const ctx = contextFor(sel);
  return Object.values(APP_DATA.features)
    .filter((f) => listedForCar(f, sel) || boundProof(f, ctx))
    .map((f) => toItem(f, ctx, sel))
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name));
}

export function findFeature(sel: CarSelection, featureId: string): CodableItem | undefined {
  return featuresFor(sel).find((f) => f.id === featureId);
}

/** Features the user can actually code — the number the Features headline shows. */
export const unlockableCount = (items: readonly FeatureItem[]): number =>
  items.filter((f) => f.tier !== 'unavailable').length;
