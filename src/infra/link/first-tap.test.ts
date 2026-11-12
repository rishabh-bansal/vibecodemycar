/**
 * First-tap success on the clone ELM327 (BLE) + VAG MQB, measured: for each recipe kind, seeds 1..N, one user tap —
 * `runSession` apply through the real Bluetooth link, ELM session, UDS channel and writer — against the seeded
 * clone simulator (testing/clone-sim.ts, calibrated by testing/clone-sim.test.ts), judged by the simulator's
 * ground truth. Everything runs in virtual time.
 *
 *   default: 60 seeds per kind (~10 s)      full: FIRST_TAP_SEEDS=500 npx vitest run src/infra/link/first-tap.test.ts
 *   Every run: the invariants below, request discipline and no false 31 everywhere, and ≥ 90 % for each kind
 *   expected to land (the B7 quirk and the dataset's backup read are `expectFailure`).
 *   BRIEF §5 gate (first-attempt ≥ 95 %, no NRC, writer p95 ≤ 15 s / p99 ≤ 25 s): FIRST_TAP_GATE=1
 *
 * Success = the session's outcome is `verified` or `observed-match` AND every DID it wrote holds the intended
 * bytes on the module. A tap includes the app's own reruns on a fresh connection (production `relink`).
 *
 * ── CURRENT: this writer, 500 seeds per kind, default FaultModel ──────────────────────────────────────────────
 *
 *   kind (feature)              first tap   dupKeys afterAck false31 lapsed2E | session p50 / p95 | writer per call p50 / p95 / p99 / max
 *   field BCM (0A5E blinks)     499  99.8 %       0        0       0        0 |  18.2 s /  26.8 s |  6.7 /  9.9 / 12.4 / 20.9 s
 *   field cluster (0E46)        493  98.6 %       0        0       0        0 |  17.8 s /  27.1 s |  7.0 / 10.7 / 12.4 / 13.5 s
 *   alt B7 (0574, quirk on)       0   0.0 %       0        0       0        0 |  39.2 s /  50.3 s | 13.5 / 17.6 / 21.7 / 26.4 s
 *   ops (CLU 228C)              499  99.8 %       0        0       0        0 |  17.3 s /  26.4 s |  6.6 /  9.2 / 12.2 / 15.1 s
 *   group 2 units (714 + 757)   495  99.0 %       0        0       0        0 |  59.5 s /  76.8 s |  6.6 / 10.0 / 12.7 / 21.6 s
 *   scalar (MIB 720D, CRC)      495  99.0 %       0        0       0        0 |  25.5 s /  38.6 s |  9.6 / 15.7 / 19.8 / 23.1 s
 *   dataset (MIB 7201, 2052 B)    0   0.0 %       0        0       0        0 |  79.5 s /  90.3 s | never reached the writer
 *
 *   0 redundant deliveries, 0 locked sends after idle or AT, 0 ATR0, 0 bare CR in 3,500 taps. The scalar's writer
 *   p95 (15.7 s) is over the §5 15 s bound: its 34-byte DID reads ~1 s each and a lost CF costs a proof window and
 *   a re-send (single-frame writes keep two complete sends; a multi-frame one may use every permitted send).
 *
 * ── BASELINE: the writer at fa56d59 (ble-writer.ts / dataset-writer.ts / uds.ts unchanged), 500 seeds per kind,
 *    default FaultModel ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *   kind (feature)              first tap   dupKeys afterAck false31 lapsed2E | session p50 / p95 | writer per call p50 / p95 / p99 / max
 *   field BCM (0A5E blinks)     475  95.0 %       0        0       0        0 |  33.4 s /  55.6 s | 16.9 / 32.3 / 43.2 / 49.3 s
 *   field cluster (0E46)        482  96.4 %       0        0       1        0 |  29.8 s /  47.7 s | 16.3 / 28.9 / 35.6 / 44.1 s
 *   alt B7 (0574, quirk on)       0   0.0 %       0        0       0        0 |  64.2 s /  86.2 s | 30.6 / 45.6 / 51.1 / 58.6 s
 *   ops (CLU 228C)              469  93.8 %       0        0       0        1 |  33.1 s /  57.1 s | 17.9 / 34.6 / 46.4 / 57.6 s
 *   group 2 units (714 + 757)   418  83.6 %       0        0       2        0 | 117.3 s / 152.3 s | 17.1 / 32.0 / 40.2 / 57.1 s
 *   scalar (MIB 720D, CRC)      455  91.0 %       0        0       0        0 |  41.8 s /  68.0 s | 20.1 / 37.3 / 48.0 / 58.8 s
 *   dataset (MIB 7201, 2052 B)    0   0.0 %       0        0       0        0 |  40.1 s /  49.5 s | never reached the writer
 *
 *   No redundant payload deliveries, 0 ATR0, 0 bare CR in 3,500 taps. Per tap: ~1 top-level send after AT commands
 *   with no search pending (the readiness 010C after ATSH7DF, which the clone drops ~93 %) and ~0.1 (group 0.35)
 *   locked sends after > 20 ms idle. The B7 always ends `no-reply` then a read-back mismatch (never an NRC).
 *   Where the misses come from: identity and backup reads (an UNABLE TO CONNECT on F190/F187/the DID is not retried
 *   by the link; a tap then relinks, up to twice, and may end "no VIN" or "didn't answer"), proof-read waits letting S3 lapse, markers recorded `not-hosted` from a
 *   lapsed-session 31 (false31), the group's four writes compounding (a part stopping mid-group: pending-uncertain),
 *   and the 2052-byte 7201 dataset, whose backup read needs ~73 RX flow-control rounds through the 4-CF cap and
 *   never completes inside the 8 s read budget (every tap then relinks twice and ends not-sent).
 *   For comparison, the deployed 26c9b50 writer under the same model lands 34.0 % (BCM) / 36.0 % (CLU) at the
 *   writer level (testing/clone-sim.test.ts, 500 seeds; live: 25–33 %); today's writer there: 97.0 % / 98.2 %.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  firstTap,
  formatSummary,
  RECIPE_KINDS,
  summarise,
  type TapResult,
} from './testing/first-tap-harness.ts';
import { installDeterministicDigest } from './testing/harness.ts';

const SEEDS = Number(process.env.FIRST_TAP_SEEDS ?? 60);
const GATE = process.env.FIRST_TAP_GATE === '1';
/**
 * The kinds BRIEF §5 gates at ≥ 95 % (K1–K5 analogues). The B7 0574 quirk is a classification check (K6), and the
 * dataset kind a known link limit (its backup read): both `expectFailure`, so neither is gated.
 */
const GATED = new Set(['field BCM', 'field cluster', 'ops', 'group 2 units', 'scalar']);
/** Every run's floor for a kind expected to land: well under the measured 100 %, over any regression worth a look. */
const FLOOR = 0.9;

let restoreDigest = () => {};
beforeAll(() => {
  restoreDigest = installDeterministicDigest();
});
afterAll(() => restoreDigest());

const sum = (runs: readonly TapResult[], f: (r: TapResult) => number) => runs.reduce((a, r) => a + f(r), 0);

describe(`first tap on the clone adapter (${SEEDS} seeds per kind${GATE ? ', BRIEF §5 gate' : ''})`, () => {
  it('is deterministic: one seed, one wire transcript', async () => {
    const kind = RECIPE_KINDS[0];
    if (!kind) throw new Error('fixture');
    const a = await firstTap(kind, 17);
    const b = await firstTap(kind, 17);
    expect(a.hash).toBe(b.hash);
    expect(a.outcome).toBe(b.outcome);
  });

  for (const kind of RECIPE_KINDS) {
    it(`${kind.kind}: ${kind.featureId}`, async () => {
      const runs: TapResult[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) runs.push(await firstTap(kind, seed));
      const s = summarise(kind.kind, runs);
      process.stdout.write(`\n[first-tap] ${formatSummary(s)}\n`);

      // ---- invariants the current writer already keeps: any change must keep them ----
      // Never a second key for one seed, never a write after the host saw it stored, never a payload delivered
      // onto bytes the module already holds, never ATR0 or a bare CR.
      expect(s.duplicateKeys).toBe(0);
      expect(s.sendsAfterAck).toBe(0);
      expect(s.redundantDeliveries).toBe(0);
      expect(s.discipline.atR0).toBe(0);
      expect(s.discipline.bareCr).toBe(0);
      // The structural request discipline (uds.ts guard) and the session-lost retry hold in every run.
      expect(s.discipline.lockedAfterIdle).toBe(0);
      expect(s.discipline.afterAtNoSearch).toBe(0);
      expect(s.falseNrc31).toBe(0);
      if (kind.expectFailure) {
        // K6 (and the dataset's backup read): never "succeeds" and is never explained as a missing setting.
        expect(s.success).toBe(0);
        expect(runs.every((r) => !/doesn.t have this setting/i.test(r.phase))).toBe(true);
        expect(runs.flatMap((r) => r.writes).every((w) => w.result?.kind !== 'acked')).toBe(true);
      } else {
        expect(s.successRate).toBeGreaterThanOrEqual(FLOOR);
      }

      if (!GATE || !GATED.has(kind.kind)) return;
      // ---- BRIEF §5 ----
      expect(s.successRate).toBeGreaterThanOrEqual(0.95);
      expect(s.lapsedPayloadWrites).toBe(0);
      expect(sum(runs, (r) => r.writes.filter((w) => w.result?.kind === 'nrc').length)).toBe(0);
      expect(s.writerP95).toBeLessThanOrEqual(15_000);
      expect(s.writerP99).toBeLessThanOrEqual(25_000);
    }, 600_000);
  }
});
