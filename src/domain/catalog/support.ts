import { knownCluster } from './cluster.ts';
import { APP_DATA } from './data.ts';
import type { DataFeature, LiveProof, Mid, Period, Vehicle } from './schema.ts';
import type { CarSelection } from './types.ts';
import { findVehicle, midOf, periodOfBuild, resolvePeriod } from './vehicles.ts';

/**
 * How well-founded a feature is for one specific car, ported from the research
 * pipeline's `support_for`. Highest evidence wins:
 *
 *   live-verified       applied + read back on a real car matching model, variant,
 *                       cluster type AND build period
 *   unverified-blocked  an attempt stopped before the main write — unknown, not refused
 *   listed              published for this variant (and period)
 *   unsupported         nothing to offer
 *
 * A proof is pinned to its exact selector: one car's result is never a family claim.
 */
export type Support = 'live-verified' | 'unverified-blocked' | 'listed' | 'unsupported';

export interface CarContext {
  vehicle: Vehicle | null;
  /** Cluster type, or null while it is not known (then no cluster-bound evidence applies). */
  mid: Mid | null;
  period: Period | null;
}

/**
 * The evidence context of a selection. The cluster type is the one the car reported on connect; a selection
 * saved by an earlier version that named its variant also keeps the cluster it named.
 */
export function contextFor(sel: CarSelection): CarContext {
  const vehicle = findVehicle(sel);
  const cluster = knownCluster(sel) ?? (vehicle ? sel.cluster : null);
  return { vehicle, mid: cluster ? midOf(cluster) : null, period: resolvePeriod(sel) };
}

/** Builds whose evidence applies to this car's manufacture period. */
export function applicableBuilds(ctx: CarContext): string[] {
  if (!ctx.vehicle) return [];
  return ctx.vehicle.listedBuilds.filter((id) => {
    const p = periodOfBuild(id);
    return p === null || ctx.period === null || p === ctx.period;
  });
}

export function proofMatches(proof: LiveProof, ctx: CarContext): boolean {
  const v = ctx.vehicle;
  if (!v) return false;
  const pv = proof.vehicle;
  if (pv.brand !== v.brand || pv.model !== v.model || pv.variant !== v.variant) return false;
  if (pv.mid && pv.mid !== ctx.mid) return false;
  // Without both periods known, the proof cannot be bound to this build.
  if (!ctx.period || !pv.build) return false;
  return pv.build === ctx.period;
}

export function boundProof(feature: DataFeature, ctx: CarContext): LiveProof | undefined {
  return feature.liveProof.find((p) => proofMatches(p, ctx));
}

/** A recorded stop-before-write attempt on this cluster type makes support unverified. */
function isBlockedOnCluster(feature: DataFeature, ctx: CarContext): boolean {
  return !!ctx.mid && feature.refusals.some((r) => r.vehicle.mid === ctx.mid);
}

export function supportFor(ctx: CarContext, feature: DataFeature): Support {
  if (!ctx.vehicle) return 'unsupported';
  if (boundProof(feature, ctx)) return 'live-verified';
  if (isBlockedOnCluster(feature, ctx)) return 'unverified-blocked';
  const builds = new Set(applicableBuilds(ctx));
  if (feature.listedOn.some((id) => builds.has(id))) return 'listed';
  return 'unsupported';
}

/** Features listed for any build of a model — used when the exact variant is unknown. */
export function listedForModel(brand: string, model: string): DataFeature[] {
  const prefix = `${brand}-${model}-`;
  return Object.values(APP_DATA.features).filter((f) => f.listedOn.some((id) => id.startsWith(prefix)));
}
