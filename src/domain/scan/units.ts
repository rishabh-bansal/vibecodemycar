import { APP_DATA } from '../catalog/data.ts';
import { SCAN_TARGETS } from '../catalog/modules.ts';
import type { CodingRecipe, ModuleAddress } from '../coding/types.ts';

/**
 * Where a unit's CAN pair comes from:
 *  - `scan-target` the app's evidenced inventory table (`SCAN_TARGETS`);
 *  - `recipe`      a shipped recipe (or one step of a group) addresses it;
 *  - `corpus`      the vendor recipe corpus names it (data/source/feature-recipes.json) though no shipped recipe does;
 *  - `convention`  the VAG UDS convention only (response = request + 0x6A); no recipe evidences it.
 */
export type UnitSource = 'scan-target' | 'recipe' | 'corpus' | 'convention';

/** One address a full scan probes: a diagnostic unit and the other unit numbers that share its CAN pair. */
export interface ScanUnit {
  unit: string;
  /** Unit numbers that answer on the same CAN pair (05 and B7 share 732/79C): their manifests read here too. */
  aliases: readonly string[];
  module: ModuleAddress;
  label: string;
  source: UnitSource;
}

/** VAG diagnostic unit names, for units the inventory table does not label. */
const UNIT_NAMES: Readonly<Record<string, string>> = {
  '01': 'engine',
  '02': 'transmission',
  '05': 'access and start authorisation',
  '10': 'park assist',
  '13': 'adaptive cruise control',
  '15': 'airbags',
  '16': 'steering column electronics',
  '18': 'auxiliary heater',
  '22': 'all-wheel drive',
  '47': 'sound system',
  '52': 'passenger door',
  '53': 'parking brake',
  '65': 'tyre pressure monitoring',
  '6C': 'rear-view camera',
  '6D': 'boot lid',
  '75': 'emergency call',
  '76': 'parking aid',
  '82': 'head-up display',
  A5: 'front camera (driver assistance)',
  B7: 'start interface',
};

/**
 * Pairs the vendor recipe corpus gives for units no shipped recipe addresses (data/source/feature-recipes.json),
 * and the OBD engine and transmission pairs (7E0/7E8, 7E1/7E9), which do not follow the +0x6A rule.
 */
const CORPUS_PAIRS: Readonly<Record<string, ModuleAddress>> = {
  '01': { request: '7E0', response: '7E8' },
  '02': { request: '7E1', response: '7E9' },
  '05': { request: '732', response: '79C' },
  '18': { request: '76A', response: '7D4' },
  '47': { request: '76F', response: '7D9' },
  '52': { request: '74B', response: '7B5' },
  '65': { request: '70B', response: '775' },
  '6C': { request: '769', response: '7D3' },
  '75': { request: '767', response: '7D1' },
  '76': { request: '70A', response: '774' },
  '82': { request: '71B', response: '785' },
};

/** Requests that follow the +0x6A convention but no recipe evidences: worth one presence probe each. */
const CONVENTION_REQUESTS: Readonly<Record<string, string>> = {
  '15': '715',
  '16': '70C',
  '53': '752',
};

const plusSixA = (request: string): string =>
  (Number.parseInt(request, 16) + 0x6a).toString(16).toUpperCase().padStart(3, '0');

/** Every unit → CAN pair a shipped recipe addresses (group steps included), first seen wins. */
function recipePairs(): Map<string, ModuleAddress> {
  const pairs = new Map<string, ModuleAddress>();
  const visit = (r: CodingRecipe) => {
    if (r.unit && r.requestId && r.responseId && !pairs.has(r.unit.toUpperCase()))
      pairs.set(r.unit.toUpperCase(), {
        request: r.requestId.toUpperCase(),
        response: r.responseId.toUpperCase(),
      });
    for (const step of r.steps ?? []) visit(step);
  };
  for (const recipe of Object.values(APP_DATA.recipes) as CodingRecipe[]) visit(recipe);
  return pairs;
}

/** The inventory table's order first (central electrics leads), then every other unit by number. */
const LEAD_ORDER = ['09', '17', '19', '03', '08', '36', '42', '44', '5F', '06'];

/**
 * Every unit address a full scan probes, one entry per CAN request id. A pair named by several sources keeps the
 * most evidenced one (inventory table, then recipe, then corpus, then convention); unit numbers sharing a pair
 * become aliases of the first.
 */
export function scanUnits(): ScanUnit[] {
  const candidates: { unit: string; module: ModuleAddress; source: UnitSource }[] = [];
  for (const [unit, target] of Object.entries(SCAN_TARGETS))
    candidates.push({ unit, module: target.module, source: 'scan-target' });
  for (const [unit, module] of recipePairs()) candidates.push({ unit, module, source: 'recipe' });
  for (const [unit, module] of Object.entries(CORPUS_PAIRS))
    candidates.push({ unit, module, source: 'corpus' });
  for (const [unit, request] of Object.entries(CONVENTION_REQUESTS))
    candidates.push({ unit, module: { request, response: plusSixA(request) }, source: 'convention' });

  const byRequest = new Map<string, ScanUnit>();
  const seenUnits = new Set<string>();
  for (const c of candidates) {
    if (seenUnits.has(c.unit)) continue;
    seenUnits.add(c.unit);
    const existing = byRequest.get(c.module.request);
    if (existing) {
      (existing.aliases as string[]).push(c.unit);
      continue;
    }
    byRequest.set(c.module.request, {
      unit: c.unit,
      aliases: [],
      module: c.module,
      label: SCAN_TARGETS[c.unit]?.label ?? UNIT_NAMES[c.unit] ?? `unit ${c.unit}`,
      source: c.source,
    });
  }
  const rank = (u: string) => {
    const i = LEAD_ORDER.indexOf(u);
    return i < 0 ? LEAD_ORDER.length : i;
  };
  return [...byRequest.values()].sort((a, b) => rank(a.unit) - rank(b.unit) || a.unit.localeCompare(b.unit));
}

/** The scan units for a `--units` filter (unit numbers or their aliases); every unit when none is given. */
export function selectScanUnits(filter?: readonly string[]): ScanUnit[] {
  const all = scanUnits();
  if (!filter?.length) return all;
  const wanted = new Set(filter.map((u) => u.trim().toUpperCase().padStart(2, '0')));
  return all.filter((u) => wanted.has(u.unit) || u.aliases.some((a) => wanted.has(a)));
}
