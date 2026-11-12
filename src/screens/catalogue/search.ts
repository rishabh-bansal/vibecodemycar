import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { APP_DATA } from '../../domain/catalog/data.ts';
import type { FeatureItem } from '../../domain/catalog/types.ts';
import { GROUP_ORDER, isGroupId } from '../../domain/catalogue/groups.ts';
import type { Tab } from '../../domain/catalogue/query.ts';
import { appFeatureIds } from '../../domain/catalogue/status.ts';
import type { CatalogueFeature, GroupId } from '../../domain/catalogue/types.ts';

/** URL state (`?car=kushaq&tab=unlocks&g=dashboard&q=…&f=<slug>`): shareable, and Back works. */
export interface CatalogueSearch {
  car?: string | undefined;
  tab?: Tab | undefined;
  g?: string | undefined;
  q?: string | undefined;
  f?: string | undefined;
}

export const parseGroups = (g: string | undefined): GroupId[] => {
  const wanted = new Set((g ?? '').split(',').filter(isGroupId));
  return GROUP_ORDER.filter((x) => wanted.has(x));
};
export const serializeGroups = (groups: readonly GroupId[]): string | undefined =>
  groups.length ? groups.join(',') : undefined;

/** Typed read/update of the catalogue's search params. Filters replace history; opening a feature pushes it. */
export function useCatalogueSearch() {
  const search = useSearch({ from: '/features' });
  const navigate = useNavigate({ from: '/features' });
  const update = useCallback(
    (patch: Partial<CatalogueSearch>, opts: { replace?: boolean } = { replace: true }) =>
      navigate({ search: (prev) => ({ ...prev, ...patch }), replace: opts.replace ?? true }),
    [navigate],
  );
  return useMemo(() => ({ search, update }), [search, update]);
}

// ───────────────────────────── matching ─────────────────────────────

/**
 * Words people use for the same feature. A query holding any phrase of a group matches a feature that
 * mentions any phrase of that group ("DRL" finds "daytime running lights"; "blinks" finds the comfort
 * turn signals). Lower case, plain words; plural forms are listed where the singular is not a prefix.
 */
export const SYNONYMS: readonly (readonly string[])[] = [
  [
    'drl',
    'drls',
    'daytime running light',
    'daytime running lamp',
    'daytime light',
    'day light',
    'day time running',
  ],
  [
    'blinks',
    'blink',
    'comfort blinker',
    'comfort indicator',
    'comfort turn signal',
    'comfort signal',
    'lane change',
    'one touch indicator',
    'flashes',
  ],
  ['needle sweep', 'needle test', 'gauge test', 'gauge sweep', 'staging', 'dial sweep'],
  ['mirror fold', 'mirrors fold', 'fold mirror', 'folding mirror', 'mirror folding', 'auto fold', 'orvm'],
  ['coming home', 'leaving home', 'follow me home', 'guide light', 'welcome light'],
  ['seat belt', 'seatbelt', 'belt warning', 'belt chime', 'belt reminder'],
  ['speed warning', 'speed chime', 'speed alert', 'speed beep', 'overspeed'],
  ['hill hold', 'hill start', 'hill assist'],
  ['tpms', 'tyre pressure', 'tire pressure'],
  ['fog light', 'fog lamp', 'foglight', 'foglamp'],
  ['start stop', 'auto start', 'start-stop'],
  ['boot', 'trunk', 'tailgate'],
  ['bonnet', 'hood'],
  ['video in motion', 'vim', 'video while driving'],
  ['alarm', 'anti theft', 'anti-theft'],
  ['lock sound', 'lock beep', 'horn', 'honk', 'acoustic confirmation'],
  ['xds', 'differential lock', 'torque vectoring'],
  ['rpm', 'tachometer', 'rev counter', 'engine speed'],
  ['oil temperature', 'oil temp'],
  ['windows', 'window', 'comfort opening', 'comfort closing', 'convenience opening'],
  ['climate', 'air con', 'hvac', 'a/c', 'aircon'],
  ['infotainment', 'multimedia', 'head unit', 'touchscreen'],
  ['virtual cockpit', 'digital cluster', 'digital cockpit', 'mid', 'dashboard display'],
];

/** Lower case, accents and punctuation folded to single spaces (keeps `/` and `-` inside words). */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, ' ')
    .trim();
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * Synonym phrases, normalized, longest first — so "comfort turn signal" wins over "signal". Each is found in
 * a query as whole words, with an optional plural "s" ("daytime running lights").
 */
const PHRASES: readonly { phrase: string; group: number; inQuery: RegExp }[] = SYNONYMS.flatMap((g, group) =>
  g.map((p) => {
    const phrase = normalizeSearch(p);
    return { phrase, group, inQuery: new RegExp(` ${escapeRegExp(phrase)}s? `) };
  }),
).sort((a, b) => b.phrase.length - a.phrase.length);

/** `phrase` starts a word of `padded` (` text `), so "fold" finds "folding" but "ac" never finds "back". */
const hasPhrase = (padded: string, phrase: string): boolean => padded.includes(` ${phrase}`);

/** Everything a feature can be found by, folded into one string: names, description and setting labels. */
export function searchText(parts: readonly (string | undefined)[]): string {
  return ` ${normalizeSearch(parts.filter(Boolean).join(' '))} `;
}

/**
 * A catalogue card's search text: its shown name and description, the names it has been known by (so an
 * older name still finds it), and the setting labels the app offers for it.
 */
export function featureSearchText(feature: CatalogueFeature, item?: FeatureItem): string {
  const known = appFeatureIds(feature.slug).map((id) => APP_DATA.features[id]?.name);
  return searchText([
    feature.name,
    feature.intro,
    feature.original?.name,
    feature.original?.intro,
    ...known,
    item?.name,
    ...(item?.settings.map((s) => s.label) ?? []),
  ]);
}

/** An app item's search text (features with no catalogue card). */
export function itemSearchText(item: FeatureItem, description?: string): string {
  return searchText([
    item.name,
    APP_DATA.features[item.id]?.name,
    description,
    ...item.settings.map((s) => s.label),
  ]);
}

/**
 * Does `text` (from {@link searchText}) answer `query`? The whole query as typed, or: every synonym
 * phrase in the query found as any phrase of its group, and every other word found as the start of a word.
 * An empty query matches everything.
 */
export function matchesSearch(text: string, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  if (hasPhrase(text, q)) return true;
  let rest = ` ${q} `;
  for (const { group, inQuery } of PHRASES) {
    if (!inQuery.test(rest)) continue;
    const found = SYNONYMS[group]?.some((p) => hasPhrase(text, normalizeSearch(p))) ?? false;
    if (!found) return false;
    rest = rest.replace(inQuery, ' ');
  }
  return rest
    .split(' ')
    .filter(Boolean)
    .every((word) => hasPhrase(text, word));
}
