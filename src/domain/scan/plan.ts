import { APP_DATA } from '../catalog/data.ts';
import type { CodingRecipe } from '../coding/types.ts';
import { LAMP_DIDS } from './lamps.ts';
import type { ScanUnit } from './units.ts';

/**
 * Identity identifiers a scan asks every fitted unit (only answered ones are kept): part number F187, software
 * version F189, hardware number F191, system name F197, ODX dataset F19E, ODX version F1A2, hardware version F1A3,
 * workshop system name F1AA, FAZIT F17C, serial F18C, VIN F190.
 */
export const IDENTITY_DIDS: readonly string[] = [
  'F187',
  'F189',
  'F191',
  'F197',
  'F19E',
  'F1A2',
  'F1A3',
  'F1AA',
  'F17C',
  'F18C',
  'F190',
];

/** The VAG variant-coding block. */
export const CODING_DID = '0600';

/** Identifier ranges a deep scan sweeps, by unit: adaptation, measuring and coding ranges. */
export const DEEP_RANGES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  '09': [
    [0x0400, 0x0bff],
    [0x5000, 0x50ff],
    [0x6000, 0x60ff],
  ],
  '17': [
    [0x0400, 0x0bff],
    [0x5000, 0x50ff],
    [0x6000, 0x60ff],
  ],
};

export type DidSource = 'identity' | 'coding' | 'recipe' | 'lamp' | 'manifest' | 'deep';

const didHex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** Every recipe (group steps included) whose own address is this CAN request id. */
export function recipesOn(request: string): CodingRecipe[] {
  const out: CodingRecipe[] = [];
  const visit = (r: CodingRecipe) => {
    if (r.requestId?.toUpperCase() === request.toUpperCase()) out.push(r);
    for (const step of r.steps ?? []) visit(step);
  };
  for (const recipe of Object.values(APP_DATA.recipes) as CodingRecipe[]) visit(recipe);
  return out;
}

/** The identifiers recipes on this address read: the plain DID and every variant's (all steps of all groups). */
export function recipeDids(request: string): string[] {
  const dids = new Set<string>();
  for (const r of recipesOn(request)) {
    if (r.did) dids.add(r.did.toUpperCase());
    for (const v of r.variants ?? []) if (v.did) dids.add(v.did.toUpperCase());
  }
  return [...dids].sort();
}

export interface ReadPlan {
  unit: ScanUnit;
  /** In read order; no duplicates. */
  dids: string[];
  source: Record<string, DidSource>;
  /** Deep-sweep ranges for this unit, each walked after `dids` (identifiers already planned are skipped). */
  deep: { from: string; to: string; dids: string[] }[];
}

/**
 * What a scan reads on one fitted unit, in order: identity, the coding block 0600, every identifier a recipe on
 * this address uses (so an early stop still settles the features), the BCM lamp records 0550..0583, then the
 * CarScanner backup manifest of the unit and its aliases. A deep scan adds the unit's ranges, skipping all of it.
 */
export function readPlan(unit: ScanUnit, opts: { deep?: boolean } = {}): ReadPlan {
  const source: Record<string, DidSource> = {};
  const dids: string[] = [];
  const add = (did: string, from: DidSource) => {
    const d = did.toUpperCase();
    if (source[d]) return;
    source[d] = from;
    dids.push(d);
  };
  for (const d of IDENTITY_DIDS) add(d, 'identity');
  add(CODING_DID, 'coding');
  for (const d of recipeDids(unit.module.request)) add(d, 'recipe');
  if (unit.unit === '09' || unit.aliases.includes('09')) for (const d of LAMP_DIDS) add(d, 'lamp');
  for (const u of [unit.unit, ...unit.aliases])
    for (const d of APP_DATA.backupDids?.[u] ?? []) add(d, 'manifest');
  const deep = opts.deep
    ? [unit.unit, ...unit.aliases]
        .flatMap((u) => DEEP_RANGES[u] ?? [])
        .map(([from, to]) => ({
          from: didHex(from),
          to: didHex(to),
          dids: Array.from({ length: to - from + 1 }, (_, i) => didHex(from + i)).filter((d) => !source[d]),
        }))
    : [];
  return { unit, dids, source, deep };
}
