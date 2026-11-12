import { opsHold, readCodingValue, readScalarValue } from '@obdcraft/coding/blocks';
import { APP_DATA } from '../catalog/data.ts';
import { type Resolved, resolveRecipe } from './plan.ts';
import type { CodingRecipe, FeatureReportEntry } from './types.ts';

/** The encoding of every variant (or the recipe itself), with the selector it is reported under. */
function layoutsOf(recipe: CodingRecipe): { selector: string; resolved: Resolved }[] {
  const picks = recipe.variants?.length ? recipe.variants.map((_, index) => ({ index })) : [undefined];
  return picks.flatMap((pick) => {
    try {
      const resolved = resolveRecipe(recipe, pick);
      const selector = pick ? (recipe.variants?.[pick.index]?.selector ?? '') : '';
      return [{ selector, resolved }];
    } catch {
      return [];
    }
  });
}

/** Decodes the current state of one layout from its DID's bytes; undefined when it does not fit. */
export function decodeLayout(r: Resolved, bytes: string): { value: number; choiceId?: string } | undefined {
  const length = bytes.length / 2;
  try {
    switch (r.encoding) {
      case 'field': {
        const field = r.field;
        if (!field) return undefined;
        const value = readCodingValue(bytes, {
          length,
          field: { ...field, choices: r.choices.map((c) => ({ id: c.id, label: c.label, value: c.value })) },
        });
        const choiceId = r.choices.find((c) => c.value === value)?.id;
        return { value, ...(choiceId ? { choiceId } : {}) };
      }
      case 'scalar': {
        if (!r.scalar) return undefined;
        const value = readScalarValue(bytes, { length, scalar: { ...r.scalar } });
        const choiceId = r.choices.find((c) => c.value === value)?.id;
        return { value, ...(choiceId ? { choiceId } : {}) };
      }
      case 'ops': {
        const index = r.choices.findIndex((c) => (c.ops?.length ?? 0) > 0 && opsHold(bytes, c.ops ?? []));
        if (index < 0) return { value: -1 };
        return { value: index, choiceId: r.choices[index]?.id as string };
      }
      case 'dataset': {
        const index = r.choices.findIndex((c) => c.payload?.toUpperCase() === bytes.toUpperCase());
        return index < 0 ? { value: -1 } : { value: index, choiceId: r.choices[index]?.id as string };
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * What a module scan says about every recipe on the unit: each recipe's variants are tried against
 * the answered map — a variant is "hosted" when its DID answered with bytes its encoding can decode. One
 * hosted variant → the feature's current setting (value → declared choice when it matches). Several
 * → unsettled (the recipe can't be pinned to one layout by the scan alone). None → not hosted here — but ONLY
 * when every variant DID carries a verdict; a DID that went silent or was never reached makes the
 * absence "unprobed", never "not hosted". A recipe without any byte-level encoding is "unmapped".
 */
export function reportFeatures(
  unit: string,
  requestId: string,
  answered: Record<string, string>,
  unresolved?: ReadonlySet<string>,
): FeatureReportEntry[] {
  const out: FeatureReportEntry[] = [];
  for (const recipe of Object.values(APP_DATA.recipes) as CodingRecipe[]) {
    if (recipe.unit !== unit || recipe.requestId !== requestId) continue;
    const layouts = layoutsOf(recipe);
    const hosted: { selector: string; did: string; value: number; choiceId?: string }[] = [];
    for (const { selector, resolved } of layouts) {
      const bytes = answered[resolved.did];
      if (!bytes) continue;
      const state = decodeLayout(resolved, bytes);
      if (state) hosted.push({ selector, did: resolved.did, ...state });
    }
    const feats = Object.values(APP_DATA.features).filter((f) => f.recipeId === recipe.id);
    const first = hosted[0];
    const missing = layouts.filter((l) => unresolved?.has(l.resolved.did)).map((l) => l.resolved.did);
    out.push({
      unit,
      recipeId: recipe.id,
      name: feats[0]?.name ?? recipe.name,
      featureIds: feats.map((f) => f.id),
      state: first
        ? hosted.length === 1
          ? { kind: 'value', ...first }
          : { kind: 'unsettled', hosted: hosted.map((h) => h.did) }
        : layouts.length
          ? missing.length
            ? { kind: 'unprobed', dids: [...new Set(missing)] }
            : { kind: 'not-hosted' }
          : { kind: 'unmapped' },
    });
  }
  return out;
}
