import type { CodingPlan } from './plan.ts';

/**
 * A byte an earlier write is known to have left wrong on a specific control unit, with the value the car held
 * before. Applied only to an apply on that unit and DID, only while the car still holds exactly the stray value,
 * and never to bits the recipe itself writes.
 */
export interface KnownRepair {
  /** F187 part number of the control unit, as the car reports it (trimmed). */
  part: string;
  request: string;
  did: string;
  offset: number;
  stray: string;
  original: string;
  note: string;
}

export const KNOWN_REPAIRS: readonly KnownRepair[] = [
  {
    // 2026-10-23 native blinks write, before ATAL: the clone dropped the 8th byte of the first frame and the BCM
    // stored A0 in byte 2. Three independent pre-write reads that day show 3A 00 00 00 00 (handover, gateway log,
    // restore journal), so byte 2 was 00.
    part: '2Q0937089D',
    request: '70E',
    did: '0A5E',
    offset: 2,
    stray: 'A0',
    original: '00',
    note: 'lost CAN frame byte from a write before ATAL (2026-10-23)',
  },
];

/** The plan with any matching known repair folded into the bytes it writes; `repaired` lists what was folded in. */
export function applyKnownRepairs(
  plan: CodingPlan,
  part: string,
  repairs: readonly KnownRepair[] = KNOWN_REPAIRS,
): { plan: CodingPlan; repaired: KnownRepair[] } {
  const repaired = repairs.filter((r) => {
    const at = r.offset * 2;
    return (
      r.part === part.trim().toUpperCase() &&
      r.request === plan.module.request.toUpperCase() &&
      r.did === plan.did.toUpperCase() &&
      plan.before.slice(at, at + 2) === r.stray &&
      plan.after.slice(at, at + 2) === r.stray &&
      (plan.owned[r.offset] ?? 0) === 0
    );
  });
  if (!repaired.length) return { plan, repaired };
  let after = plan.after;
  for (const r of repaired) after = after.slice(0, r.offset * 2) + r.original + after.slice(r.offset * 2 + 2);
  const changes = [
    ...plan.changes,
    ...repaired.map((r) => ({
      offset: r.offset,
      before: Number.parseInt(r.stray, 16),
      after: Number.parseInt(r.original, 16),
      mask: 0xff,
    })),
  ].sort((a, b) => a.offset - b.offset);
  return { plan: { ...plan, after, changes, noop: after === plan.before }, repaired };
}

export const describeRepair = (r: KnownRepair): string =>
  `Byte ${r.offset} of ${r.did} put back from ${r.stray} to ${r.original} (${r.note}).`;
