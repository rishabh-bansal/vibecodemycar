import type { ModuleAddress } from './types.ts';

/**
 * Recorded live observations of a control unit storing something other than the exact block written,
 * in bytes the recipe does not write. Only an exact match of one of these may be reported as
 * module-managed; any other difference outside the recipe is unexplained and needs review
 * (independent review 2026-10-25, R2).
 *
 * Every entry is bound to the recipe revision (digest), the module and its part number, the DID, and the
 * exact block written and read back. A new recipe revision, another part or another setting is not
 * covered and must be observed and recorded again.
 */
export interface KnownReadback {
  recipeId: string;
  /** `recipeDigest` of the recipe definition the observation was made with. */
  recipeDigest: string;
  module: ModuleAddress & { part: string };
  did: string;
  /** The exact block written. */
  intended: string;
  /** The exact block the control unit held afterwards. */
  observed: string;
  /** Where the observation is documented. */
  source: string;
}

export const KNOWN_READBACKS: readonly KnownReadback[] = [
  {
    recipeId: 'live-bcm-polite-blinks',
    recipeDigest: 'a1626fc88383417cf97d080e0fc8c6f52cb8d80169073ba8e19a4d3ecaf8d776',
    module: { request: '70E', response: '778', part: '2Q0937089D' },
    did: '0A5E',
    intended: '3E00000000',
    observed: '3E00A00000',
    source:
      'docs/handover/HANDOVER_LIVE_2026-10-23.md (20:46 write, five blinks confirmed in the car; delayed read ' +
      'reproduced A0); app-data liveProof; owner decision D3 in docs/reviews/2026-10-25/FIXES.md',
  },
];

/** The recorded observations that apply to exactly this write. */
export function knownReadbacksFor(write: {
  recipeId: string;
  recipeDigest: string;
  module: ModuleAddress;
  part: string;
  did: string;
  intended: string;
}): string[] {
  return KNOWN_READBACKS.filter(
    (k) =>
      k.recipeId === write.recipeId &&
      k.recipeDigest === write.recipeDigest &&
      k.module.request === write.module.request &&
      k.module.response === write.module.response &&
      k.module.part === write.part.trim() &&
      k.did === write.did &&
      k.intended === write.intended.toUpperCase(),
  ).map((k) => k.observed);
}
