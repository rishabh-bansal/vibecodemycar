/**
 * The health snapshot's 19 reads on the clone simulator when a unit answers `7F 19 78` and sends its fault list
 * seconds later (brakes 713 and airbags 715 live 2026-11-09). The clone prints nothing after its prompt, so the final
 * answer is only heard while the adapter is inside a send's response window: the read keeps it there with silent
 * tester presents (3E 80) instead of giving up at the prompt.
 */
import { withModuleRequests } from '@obdcraft/coding';
import { UdsExchangeError } from '@obdcraft/obd-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type EcuSpec, kushaqEcus } from '../../infra/link/testing/clone-sim.ts';
import { drive, installDeterministicDigest, simRig } from '../../infra/link/testing/harness.ts';
import { BCM_FAULTS } from '../../infra/link/testing/health-car.ts';
import { WebBluetoothLink } from '../../infra/link/web-bluetooth.ts';
import { isHealthRequest } from './readonly.ts';
import { DTC_PENDING_POLL_MS, healthRequestOptions, readUnitHealth, type UdsAnswer } from './uds.ts';

let restoreDigest = () => {};
beforeAll(() => {
  restoreDigest = installDeterministicDigest();
});
afterAll(() => restoreDigest());
afterEach(async () => {
  await WebBluetoothLink.retireCurrent();
});

const ABS = { unit: '03', label: 'brakes', request: '713', response: '77D' };

/** As `live health` classifies a request (scripts/live/health.ts), reduced to what these reads can return. */
async function classify(run: () => Promise<number[]>): Promise<UdsAnswer> {
  try {
    return { kind: 'ok', bytes: await run() };
  } catch (e) {
    if (!(e instanceof UdsExchangeError)) return { kind: 'lost', error: (e as Error).message };
    if (e.nrc !== undefined && e.nrc !== 0x78) return { kind: 'nrc', code: e.nrc };
    if (e.detail === 'pending') return { kind: 'pending' };
    if (e.failure === 'timeout') return { kind: 'no-reply' };
    return { kind: 'lost', error: e.message };
  }
}

async function readBrakes(slowDtcListMs: number, seed = 11) {
  const ecus: EcuSpec[] = kushaqEcus().map((e) =>
    e.name === 'ABS' ? { ...e, faults: BCM_FAULTS, slowDtcListMs } : e,
  );
  const rig = await simRig({ seed, ecus });
  const engine = rig.engine;
  const release = engine.link?.policy.enterHealthReadOnly() ?? (() => {});
  const timing: { pdu: string; ms: number }[] = [];
  try {
    const result = await drive(rig.clock, () =>
      withModuleRequests(
        engine,
        ABS.request,
        ABS.response,
        (send) =>
          readUnitHealth(ABS, async (pdu) => {
            const t0 = rig.clock.now();
            const a = await classify(() => send(ABS.request, ABS.response, pdu, healthRequestOptions(pdu)));
            timing.push({
              pdu: pdu
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase(),
              ms: rig.clock.now() - t0,
            });
            return a;
          }),
        8000,
      ),
    );
    const received = rig.sim.truth.flatMap((t) => (t.type === 'ecuRx' && t.ecu === '713' ? [t.bytes] : []));
    return { result, received, timing };
  } finally {
    release();
  }
}

const hexBytes = (h: string) => (h.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));

describe('19 02 answered 78, final answer seconds later (clone simulator)', () => {
  it.each([2000, 3000, 4000])(
    'hears the fault list sent %i ms after 7F 19 78',
    async (lateMs) => {
      const { result, received, timing } = await readBrakes(lateMs);
      expect(result.reachable).toBe(true);
      expect(result.faults.status).toBe('ok');
      expect(result.faults.notes.join('\n')).not.toMatch(/response pending/);
      // the two faults of the list (mask 2D), the "test not completed" entry not among them
      expect(result.faults.dtcs.map((d) => d.statusHex).sort()).toEqual(['24', '28']);
      expect(result.issues.map((i) => i.request)).not.toContain('19 02 2D');
      const list = timing.find((t) => t.pdu === '19022D');
      expect(list?.ms).toBeGreaterThanOrEqual(lateMs);
      expect(list?.ms).toBeLessThan(DTC_PENDING_POLL_MS + 6000);
      // The module was kept listening with silent tester presents; everything it received is a health read.
      expect(received).toContain('3E80');
      for (const hex of received) expect(isHealthRequest(hexBytes(hex))).toBe(true);
    },
    120_000,
  );

  it('a final answer that never comes ends as "pending", bounded, and the unit read goes on', async () => {
    const { result, timing } = await readBrakes(120_000);
    expect(result.reachable).toBe(true);
    expect(result.faults.notes).toContain('19 02: response pending, final answer never came');
    const list = timing.find((t) => t.pdu === '19022D');
    expect(list?.ms).toBeGreaterThanOrEqual(DTC_PENDING_POLL_MS);
    expect(list?.ms).toBeLessThan(DTC_PENDING_POLL_MS + 7000);
  }, 120_000);
});
