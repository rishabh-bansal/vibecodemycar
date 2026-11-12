import type { UnavailableReason } from './types.ts';

/** One label for every feature that can be set on this car: the internal tiers only order the list. */
export const AVAILABLE_LABEL = 'AVAILABLE FOR YOUR CAR';
export const NOT_AVAILABLE_LABEL = 'NOT AVAILABLE FOR YOUR CAR';
/** A feature that needs one instrument cluster type, before the car has said which it has. */
export const CLUSTER_PENDING_LABEL = 'DEPENDS ON YOUR INSTRUMENT CLUSTER';
export const CLUSTER_PENDING_NOTE = 'Depends on your instrument cluster — we check this when you connect.';

/** `analogue` → `an analogue instrument cluster`. */
export const clusterPhrase = (cluster: 'analogue' | 'digital'): string =>
  cluster === 'analogue' ? 'an analogue instrument cluster' : 'a digital instrument cluster';

/**
 * A feature is unavailable when there are no bytes to write (no recipe for this car's platform, or a recipe
 * with no byte map), or when this model's catalogue says it needs the other cluster type than the connected
 * car has. Nothing is locked by policy. The reason stays internal; the label is the same.
 */
export function unavailableLabel(_reason: UnavailableReason, _cluster: 'analogue' | 'digital'): string {
  return NOT_AVAILABLE_LABEL;
}
