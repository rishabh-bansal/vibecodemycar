/**
 * BRIEF §5 beyond `first-tap.test.ts`: the recipe kinds K3/K4 (the Kushaq catalogue's analogues) and the §5.10
 * robustness sweep, judged by the clone simulator's ground truth exactly as `first-tap.test.ts` judges the others.
 *
 *   default: K3/K4 at 30 seeds each (~2 s); full: FIRST_TAP_SEEDS=500, gate with FIRST_TAP_GATE=1
 *   sweep (§5.10, ~4 min): FIRST_TAP_SWEEP=1 [FIRST_TAP_SWEEP_SEEDS=200]
 *
 * K3 is the cluster's 22B9 (the catalogue codes the seat-belt warning there, not on the BCM). K4 is the HVAC's 0600;
 * its recipe carries a login, so with `hvacNeedsSecurity` on it unlocks and passes rather than ending in a 33.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FaultModel } from './testing/clone-sim.ts';
import {
  firstTap,
  formatSummary,
  RECIPE_KINDS,
  type RecipeKind,
  summarise,
  type TapResult,
} from './testing/first-tap-harness.ts';
import { installDeterministicDigest } from './testing/harness.ts';

const SEEDS = Number(process.env.FIRST_TAP_SEEDS ?? 30);
const GATE = process.env.FIRST_TAP_GATE === '1';
const SWEEP = process.env.FIRST_TAP_SWEEP === '1';
const SWEEP_SEEDS = Number(process.env.FIRST_TAP_SWEEP_SEEDS ?? 200);

const K3: RecipeKind = {
  kind: 'K3 CLU 22B9',
  featureId: 'seat-belt-warning-disable',
  settingId: 'res-disable',
};
const K4: RecipeKind = {
  kind: 'K4 HVAC 0600',
  featureId: 'display-automatic-climate-control-fan-blower-speed-in-ac-auto-mode',
  settingId: 'enabled',
};

let restoreDigest = () => {};
beforeAll(() => {
  restoreDigest = installDeterministicDigest();
});
afterAll(() => restoreDigest());

const run = async (kind: RecipeKind, seeds: number, model: Partial<FaultModel> = {}) => {
  const runs: TapResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) runs.push(await firstTap(kind, seed, model));
  return { runs, s: summarise(kind.kind, runs) };
};

/** BRIEF §5 criteria 2–6, which hold in every run, default model or swept. */
const invariants = (s: ReturnType<typeof summarise>) => {
  expect(s.duplicateKeys).toBe(0);
  expect(s.sendsAfterAck).toBe(0);
  expect(s.redundantDeliveries).toBe(0);
  expect(s.falseNrc31).toBe(0);
  expect(s.lapsedPayloadWrites).toBe(0);
  expect(s.discipline).toEqual({ lockedAfterIdle: 0, afterAtNoSearch: 0, atR0: 0, bareCr: 0 });
};

describe(`first tap, K3/K4 (${SEEDS} seeds per kind${GATE ? ', BRIEF §5 gate' : ''})`, () => {
  for (const kind of [K3, K4]) {
    it(`${kind.kind}: ${kind.featureId}`, async () => {
      const { runs, s } = await run(kind, SEEDS);
      process.stdout.write(`\n[first-tap] ${formatSummary(s)}\n`);
      invariants(s);
      if (!GATE) return;
      expect(s.successRate).toBeGreaterThanOrEqual(0.95);
      expect(runs.flatMap((r) => r.writes).filter((w) => w.result?.kind === 'nrc')).toHaveLength(0);
      expect(s.writerP95).toBeLessThanOrEqual(15_000);
      expect(s.writerP99).toBeLessThanOrEqual(25_000);
    }, 600_000);
  }
});

/** BRIEF §5.10: each variant alone, 200 seeds per kind; success ≥ 90 % and criteria 2–6. */
const VARIANTS: readonly [string, Partial<FaultModel>][] = [
  ['T_stale 50 ms', { staleIdleMs: 50 }],
  ['T_stale 150 ms', { staleIdleMs: 150 }],
  ['T_stale 450 ms', { staleIdleMs: 450 }],
  ['p_L 0.30', { pLocked: 0.3 }],
  ['search 0.10 / 0.50', { pSearchOk: 0.1, pSearchAfterSilent: 0.5 }],
  ['p_rxLoss 0.02', { pRxLoss: 0.02 }],
  ['commit 1–4 s', { commitMs: [1000, 4000] }],
  ['cluster seed per request', { cluSeedPerRequest: true }],
  ['HVAC needs security', { hvacNeedsSecurity: true }],
];
const SWEPT = [...RECIPE_KINDS.filter((k) => !k.expectFailure && k.kind !== 'dataset'), K3, K4];

describe.runIf(SWEEP)(`robustness sweep (BRIEF §5.10, ${SWEEP_SEEDS} seeds per kind)`, () => {
  for (const [name, model] of VARIANTS) {
    for (const kind of SWEPT) {
      it(`${name}: ${kind.kind}`, async () => {
        const { s } = await run(kind, SWEEP_SEEDS, model);
        process.stdout.write(`\n[sweep ${name}] ${formatSummary(s)}\n`);
        invariants(s);
        expect(s.successRate).toBeGreaterThanOrEqual(0.9);
      }, 1_200_000);
    }
  }
});
