import type { ModuleAddress } from '../coding/types.ts';
import { APP_DATA } from './data.ts';

/**
 * Control units the app can inventory-read, keyed by diagnostic unit. Every CAN pair is evidenced —
 * in a corpus recipe (`requestId`/`responseId`) or in the session ritual itself (the gateway `19`,
 * which every session opens). A unit joins only while the CarScanner backup manifest lists
 * identifiers for it (`APP_DATA.backupDids`), so a scan always has a real list to walk.
 */
export const SCAN_TARGETS: Readonly<Record<string, { module: ModuleAddress; label: string }>> = {
  '09': { module: { request: '70E', response: '778' }, label: 'central electrics' },
  '17': { module: { request: '714', response: '77E' }, label: 'instrument cluster' },
  '19': { module: { request: '710', response: '77A' }, label: 'gateway' },
  '03': { module: { request: '713', response: '77D' }, label: 'brakes' },
  '08': { module: { request: '746', response: '7B0' }, label: 'climate control' },
  '36': { module: { request: '74C', response: '7B6' }, label: 'parking aid' },
  '42': { module: { request: '74A', response: '7B4' }, label: 'driver door' },
  '44': { module: { request: '712', response: '77C' }, label: 'power steering' },
  '5F': { module: { request: '773', response: '7DD' }, label: 'infotainment' },
  '06': { module: { request: '74D', response: '7B7' }, label: 'seat memory' },
};

/**
 * Declared sweep order — `Object.keys` would silently reorder integer-like keys, so the order lives
 * here explicitly. Central electrics goes first (richest inventory); the gateway follows the cluster.
 */
const SCAN_ORDER = ['09', '17', '19', '03', '08', '36', '42', '44', '5F', '06'] as const;

/** Units that have both a known CAN pair and an identifier inventory — the ones a scan can run. */
export function scannableUnits(): string[] {
  return SCAN_ORDER.filter((u) => (APP_DATA.backupDids?.[u]?.length ?? 0) > 0);
}

/**
 * Identifiers a unit's recipes actually read — every variant DID plus the plain recipe DID. These
 * probe FIRST in a sweep: a scan that dies early (unstable adapter, sweep budget) still resolves
 * the features the user can act on, rather than burning the window walking the manifest in order.
 * Sorted for determinism; DIDs already in the manifest keep their position in the trailing tail.
 */
export function featureDids(unit: string, requestId: string): string[] {
  const dids = new Set<string>();
  for (const recipe of Object.values(APP_DATA.recipes)) {
    if (recipe.unit !== unit || recipe.requestId !== requestId) continue;
    if (recipe.did) dids.add(recipe.did);
    for (const v of recipe.variants ?? []) if (v.did) dids.add(v.did);
  }
  return [...dids].sort();
}
