/**
 * VAG variant settlement — a PURE resolver (G1).
 *
 * Ported semantics from vagcan's `.rod` filename algebra (pinned
 * `7e6333c3`, `label_files.rs`/`extracted.rs`): a unit's dataset variant is
 * named `<F19E>[_<vvv>][_<project>]` where `vvv` is the first three
 * characters of F1A2 and `project` is the car's gateway project code.
 * `ReDir.rod` supplies source→target redirects resolved at the source's rank;
 * a redirect to `EMPTY` means "no data" — never guess a sibling.
 *
 * Safety rules (kept verbatim):
 * - F1A2 missing or best rank only Localised/Family → refused. Never a
 *   family union, never a guess.
 * - Equally ranked matches are retained together and returned as a list —
 *   a surviving tie is `ambiguous`, NOT a unique winner. Best rank does not
 *   imply a single variant.
 * - F19E and F1A2 are preserved in full; only `odxVersion3` is truncated
 *   for filename matching.
 *
 * No I/O, no bus access, no write capability — resolution informs reads and
 * backup plans only. A settled variant never authorizes a write.
 */

export type OdxRank = 'VersionProject' | 'Version' | 'Project' | 'Exact' | 'Localised' | 'Family';

export const RANK_ORDER: readonly OdxRank[] = ['VersionProject', 'Version', 'Project', 'Exact', 'Localised', 'Family'];

/** Ranks VCDS itself trusts for a lookup (vagcan `is_vcds_lookup`). */
export const VCDS_RANKS: ReadonlySet<OdxRank> = new Set(['VersionProject', 'Version', 'Project', 'Exact']);

export interface VariantRef {
  /** Full F19E ODX filename — e.g. 'EV_ACClimaBHBMQBA0Touch'. */
  odxName: string;
  /** Full F1A2 ODX version — preserved verbatim for identity. */
  odxVersion: string;
  /** First three characters of F1A2 — used ONLY for filename matching. */
  odxVersion3: string;
  /** Gateway project code when the CAR reports one — never invented. */
  project: string | null;
}

/** Derive the variant reference from live identity evidence. Incomplete or
 * malformed identity → null. The version key must be exactly three
 * alphanumeric characters — a malformed F1A2 cannot settle anything. */
export function deriveVariantRef(identity: { odxFile: string | null; odxVersion: string | null }, project: string | null = null): VariantRef | null {
  if (!identity.odxFile || !identity.odxVersion) return null;
  const odxVersion3 = identity.odxVersion.slice(0, 3);
  if (!/^[0-9A-Za-z]{3}$/.test(odxVersion3)) return null;
  return Object.freeze({
    odxName: identity.odxFile,
    odxVersion: identity.odxVersion,
    odxVersion3,
    project: project && project.trim() ? project.trim().toUpperCase() : null,
  });
}

/**
 * Rank one dataset/`.rod` stem against the unit's variant ref.
 * Returns null when the stem does not belong to this ODX family at all.
 * `stem` may include a `.rod` suffix — it is stripped.
 */
export function rankCandidateName(stem: string, ref: VariantRef): OdxRank | null {
  const base = stem.replace(/\.rod$/i, '');
  if (base === ref.odxName) return 'Exact';
  if (!base.startsWith(ref.odxName + '_')) return null;
  const rest = base.slice(ref.odxName.length + 1);
  const segs = rest.split('_');
  const [s1, s2] = segs;
  if (segs.length === 2 && ref.project !== null && s1 === ref.odxVersion3 && s2 === ref.project) return 'VersionProject';
  if (segs.length === 1 && s1 === ref.odxVersion3) return 'Version';
  if (segs.length === 1 && ref.project !== null && s1 === ref.project) return 'Project';
  if (segs.length === 2 && s1 === ref.odxVersion3) return 'Localised';
  return 'Family';
}

export interface BestVariants {
  rank: OdxRank;
  /** Every candidate at the best rank — ties preserved, never reduced. */
  names: string[];
}

/** Keep only candidates at the best rank present; unrelated names drop out. */
export function bestVariants(stems: string[], ref: VariantRef): BestVariants | null {
  let best = Number.POSITIVE_INFINITY;
  const ranked: { name: string; rank: OdxRank }[] = [];
  for (const s of stems) {
    const r = rankCandidateName(s, ref);
    if (!r) continue;
    const i = RANK_ORDER.indexOf(r);
    if (i < best) { best = i; ranked.length = 0; }
    if (i === best) ranked.push({ name: s.replace(/\.rod$/i, ''), rank: r });
  }
  if (best === Number.POSITIVE_INFINITY) return null;
  const names = [...new Set(ranked.map(r => r.name))].sort();
  return { rank: RANK_ORDER[best]!, names };
}

export type VariantResolution =
  | { status: 'settled'; rank: OdxRank; name: string }
  | { status: 'ambiguous'; rank: OdxRank; names: string[] }
  /** Exploratory-only result — a non-VCDS-trusted rank (Localised/Family)
   *  was explicitly allowed for inspection. NEVER a usable settled variant. */
  | { status: 'candidate'; rank: OdxRank; names: string[] }
  | { status: 'nothing'; reason: 'redirect-empty'; source: string }
  | { status: 'refused'; reason: 'identity-incomplete' | 'rank-insufficient' | 'no-candidates' | 'redirect-target-missing' | 'redirect-cycle'; rank?: OdxRank; names?: string[] };

export interface SettleOptions {
  /** `ReDir.rod` source-stem → target-stem map. `EMPTY` means "no data".
   *  Redirects are evaluated for every source that ranks, whether or not the
   *  source stem itself is in the available list — the ReDir table is data,
   *  not a file. */
  redirects?: Record<string, string>;
  /** When true (default), only VCDS-trusted ranks 1–4 may settle; below-rank
   *  best matches are refused. When false they surface as `candidate` —
   *  exploratory-ranked, explicitly NOT a settled usable dataset. */
  vcdsLookup?: boolean;
}

/**
 * Settle the unit's dataset variant from available `.rod`/dataset stems.
 * A resolved variant is evidence for reads — never write permission.
 *
 * Redirect rules: `ReDir` mappings apply at the SOURCE's rank; a redirect to
 * `EMPTY` is a definitive "no data"; a redirect target must itself be an
 * available stem (dangling targets are refused, not guessed); cycles are
 * refused after a bounded follow.
 */
export function settleVariant(stems: string[], ref: VariantRef | null, opts: SettleOptions = {}): VariantResolution {
  if (!ref) return { status: 'refused', reason: 'identity-incomplete' };
  const vcds = opts.vcdsLookup !== false;
  const redirects = opts.redirects ?? {};
  const stemsSet = new Set(stems.map(s => s.replace(/\.rod$/i, '')));

  interface Entry { source: string; rank: OdxRank; resolved: string | null; emptied: boolean; cycle: boolean }
  const pool: Entry[] = [];

  // ReDir sources enumerate independently — the map is data, not a file list.
  for (const [src, tgt] of Object.entries(redirects)) {
    const rank = rankCandidateName(src, ref);
    if (!rank) continue;
    // Follow the chain: ReDir targets may themselves redirect. Bounded, cycle-checked.
    let target: string | null = tgt;
    const seen = new Set([src]);
    let cycle = false;
    for (let hops = 0; target !== 'EMPTY' && target !== null && redirects[target] !== undefined && hops < 8; hops++) {
      if (seen.has(target)) { cycle = true; target = null; break; }
      seen.add(target);
      target = redirects[target]!;
    }
    if (target !== 'EMPTY' && target !== null && redirects[target] !== undefined) { cycle = true; target = null; }
    // A redirect target is usable only when its dataset is actually present —
    // a dangling ReDir must not settle on a file that does not exist.
    const usable = target !== 'EMPTY' && target !== null && stemsSet.has(target);
    pool.push({ source: src, rank, resolved: usable ? target : null, emptied: target === 'EMPTY', cycle });
  }
  // Plain stems not claimed by a ReDir source rank normally.
  for (const s of stemsSet) {
    if (redirects[s] !== undefined) continue;
    const rank = rankCandidateName(s, ref);
    if (rank) pool.push({ source: s, rank, resolved: s, emptied: false, cycle: false });
  }
  if (!pool.length) return { status: 'refused', reason: 'no-candidates' };

  const bestIdx = Math.min(...pool.map(r => RANK_ORDER.indexOf(r.rank)));
  const atBest = pool.filter(r => RANK_ORDER.indexOf(r.rank) === bestIdx);
  const rank = RANK_ORDER[bestIdx]!;

  // A redirect to EMPTY at the winning rank is a definitive "no data" for this
  // unit — vagcan returns UnitRods::nothing rather than guessing a sibling.
  const emptied = atBest.find(r => r.emptied);
  if (emptied) return { status: 'nothing', reason: 'redirect-empty', source: emptied.source };
  if (atBest.some(r => r.cycle)) return { status: 'refused', reason: 'redirect-cycle', rank };

  const usable = atBest.filter(r => r.resolved !== null);
  if (!usable.length) return { status: 'refused', reason: 'redirect-target-missing', rank };

  if (!VCDS_RANKS.has(rank)) {
    const names = [...new Set(usable.map(r => r.resolved!))].sort();
    return vcds
      ? { status: 'refused', reason: 'rank-insufficient', rank, names }
      : { status: 'candidate', rank, names };
  }

  const names = [...new Set(usable.map(r => r.resolved!))].sort();
  if (names.length > 1) return { status: 'ambiguous', rank, names };
  return { status: 'settled', rank, name: names[0]! };
}

/** Human-readable verdict for logs/UI — resolution outcomes stay explicit. */
export function resolutionSummary(res: VariantResolution): string {
  switch (res.status) {
    case 'settled': return `settled ${res.rank}: ${res.name}`;
    case 'ambiguous': return `ambiguous ${res.rank}: ${res.names.join(' | ')} — ties retained, unresolved`;
    case 'candidate': return `candidate-only ${res.rank}: ${res.names.join(' | ')} — exploratory, not a usable variant`;
    case 'nothing': return `nothing: ReDir ${res.source} → EMPTY`;
    case 'refused': {
      const detail = res.names?.length ? ` (${res.names.join(' | ')})` : '';
      return `refused ${res.reason}${res.rank ? ` ${res.rank}` : ''}${detail}`;
    }
  }
}
