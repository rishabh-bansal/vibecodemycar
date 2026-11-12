import { GROUP_ORDER, UNLOCK_GROUPS } from './groups.ts';
import type { CatalogueFeature, CatalogueModel, GroupId } from './types.ts';

export type Tab = 'unlocks' | 'service';

export interface Filters {
  tab: Tab;
  /** Empty = all. Mobile keeps this to one entry; desktop allows several. */
  groups: readonly GroupId[];
  query: string;
}

export const tabFeatures = (model: CatalogueModel, tab: Tab): readonly CatalogueFeature[] =>
  tab === 'service' ? model.service : model.unlocks;

/** Case-insensitive match on name + intro. */
export function matchesQuery(f: CatalogueFeature, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || f.name.toLowerCase().includes(q) || f.intro.toLowerCase().includes(q);
}

/**
 * car × tab × chips × search — the filters always compose. `matches` replaces the plain name + intro match
 * (the features screen passes its synonym-aware search).
 */
export function applyFilters(
  model: CatalogueModel,
  { tab, groups, query }: Filters,
  matches: (f: CatalogueFeature, query: string) => boolean = matchesQuery,
): CatalogueFeature[] {
  return tabFeatures(model, tab).filter(
    (f) => (groups.length === 0 || groups.includes(f.group)) && matches(f, query),
  );
}

/**
 * The same list with the features this car can take first and the rest after, each part in its original
 * order (the sort is stable). Used everywhere features are listed.
 */
export function codableFirst<T>(list: readonly T[], codable: (item: T) => boolean): T[] {
  return list
    .map((item, i) => ({ item, i, rank: codable(item) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}

export interface Section {
  group: GroupId;
  features: CatalogueFeature[];
}

/** Features grouped in display order; empty groups are dropped. */
export function toSections(features: readonly CatalogueFeature[]): Section[] {
  return GROUP_ORDER.map((group) => ({ group, features: features.filter((f) => f.group === group) })).filter(
    (s) => s.features.length > 0,
  );
}

/** Chip counts for a tab — counted BEFORE chip/search filtering, so chips never "move" while typing. */
export function chipCounts(model: CatalogueModel, tab: Tab): { group: GroupId; count: number }[] {
  const list = tabFeatures(model, tab);
  const groups = tab === 'service' ? (['service'] as const) : UNLOCK_GROUPS;
  return groups
    .map((group) => ({ group, count: list.filter((f) => f.group === group).length }))
    .filter((c) => c.count > 0);
}
