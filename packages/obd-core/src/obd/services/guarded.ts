import { OBD } from '@obdcraft/definitions';
import { bitmapPids, type ObdContext } from '../context.ts';
import type { RequestRecord } from '../records.ts';
import { okResults } from '../request.ts';
import { readMode01 } from './service01.ts';
import { toHex } from '../../util/hex.ts';

export const CLEAR_CONFIRM_PHRASE = 'CLEAR';

export const CLEAR_WARNING = OBD.services.find((s) => s.id === '04')!.warning!;

export interface ClearPrecheck {
  ok: boolean;
  rpm: number | null;
  speed: number | null;
  reasons: string[];
  records: RequestRecord[];
}

/** Reads RPM and speed immediately before a clear: engine must be off (0 rpm) and the car stationary. */
export async function clearPrecheck(ctx: ObdContext): Promise<ClearPrecheck> {
  const records: RequestRecord[] = [];
  const engine = [...ctx.ecus.values()].find((e) => e.role === 'engine');
  const expect = engine ? [engine.id] : undefined;
  const rpmRes = await readMode01(ctx, [0x0c], { purpose: 'clear', expectEcus: expect, retryNoData: true });
  const spdRes = await readMode01(ctx, [0x0d], { purpose: 'clear', expectEcus: expect, retryNoData: true });
  records.push(rpmRes.record, spdRes.record);
  const rpm = rpmRes.readings.find((r) => r.key === 'rpm')?.value ?? null;
  const speed = spdRes.readings.find((r) => r.key === 'speed')?.value ?? null;
  const reasons: string[] = [];
  if (rpm === null) reasons.push('could not read engine speed');
  else if (rpm > 0) reasons.push(`engine is running (${rpm} rpm): switch the engine off, leave the ignition on`);
  if (speed === null) reasons.push('could not read vehicle speed');
  else if (speed > 0) reasons.push(`car is moving (${speed} km/h)`);
  return { ok: reasons.length === 0, rpm, speed, reasons, records };
}

export interface ClearResult {
  sent: boolean;
  precheck: ClearPrecheck;
  record?: RequestRecord;
  acknowledgedBy: string[];
  error?: string;
}

/**
 * Service 04 (clear codes). The only write OBDCraft can do, and only through
 * here: typed confirmation, then RPM 0 and speed 0 read just before sending.
 */
export async function clearCodesGuarded(ctx: ObdContext, typedConfirmation: string, acknowledgedWarning: boolean): Promise<ClearResult> {
  const empty: ClearPrecheck = { ok: false, rpm: null, speed: null, reasons: [], records: [] };
  if (!acknowledgedWarning) return { sent: false, precheck: empty, acknowledgedBy: [], error: 'warning not acknowledged' };
  if (typedConfirmation.trim().toUpperCase() !== CLEAR_CONFIRM_PHRASE) {
    return { sent: false, precheck: empty, acknowledgedBy: [], error: `type ${CLEAR_CONFIRM_PHRASE} to confirm` };
  }
  const precheck = await clearPrecheck(ctx);
  if (!precheck.ok) return { sent: false, precheck, acknowledgedBy: [], error: precheck.reasons.join('; ') };
  const token = ctx.link.policy.issueClearToken();
  const record = await ctx.runner.execute({
    service: 0x04, params: [], purpose: 'clear', clearToken: token, expectEcus: [...ctx.ecus.keys()], maxAttempts: 1, timeoutMs: 5000,
  });
  return { sent: true, precheck, record, acknowledgedBy: okResults(record).map((r) => r.ecu) };
}

export interface OnboardTestsResult {
  /** Test IDs the vehicle says exist (service 08). OBDCraft never runs them. */
  perEcu: { ecu: string; tids: number[] }[];
  state: 'listed' | 'unavailable';
  record: RequestRecord;
}

/** Service 08: only "0800", the list of available tests. Nothing is run. */
export async function listOnboardTests(ctx: ObdContext): Promise<OnboardTestsResult> {
  const record = await ctx.runner.execute({ service: 0x08, params: [0x00], purpose: 'scan', maxAttempts: 2 });
  const perEcu = okResults(record).map((r) => ({ ecu: r.ecu, tids: bitmapPids(0, r.payload.slice(2, 6)).filter((t) => t % 0x20 !== 0) }));
  return { perEcu, state: perEcu.length ? 'listed' : 'unavailable', record };
}

export interface O2TestResult {
  applicable: boolean;
  reason?: string;
  tests: { ecu: string; tid: number; sensor: number; raw: string; value: number | null; unit: string | null; name: string }[];
  records: RequestRecord[];
}

const MODE05_TIDS: Record<number, { name: string; scale: number; unit: string }> = {
  0x01: { name: 'Rich-to-lean threshold voltage', scale: 0.005, unit: 'V' },
  0x02: { name: 'Lean-to-rich threshold voltage', scale: 0.005, unit: 'V' },
  0x03: { name: 'Low voltage for switch time', scale: 0.005, unit: 'V' },
  0x04: { name: 'High voltage for switch time', scale: 0.005, unit: 'V' },
  0x05: { name: 'Rich-to-lean switch time', scale: 0.004, unit: 's' },
  0x06: { name: 'Lean-to-rich switch time', scale: 0.004, unit: 's' },
  0x07: { name: 'Minimum sensor voltage', scale: 0.005, unit: 'V' },
  0x08: { name: 'Maximum sensor voltage', scale: 0.005, unit: 'V' },
  0x09: { name: 'Time between transitions', scale: 0.04, unit: 's' },
  0x0a: { name: 'Sensor period', scale: 0.04, unit: 's' },
};

/** Service 05 (non-CAN only): oxygen sensor test results. On CAN the same data lives in service 06. */
export async function readO2Tests(ctx: ObdContext, sensors: number[] = [0x01, 0x02]): Promise<O2TestResult> {
  if (ctx.link.protocol.family !== 'legacy') {
    return { applicable: false, reason: 'service 05 is not used on CAN; oxygen sensor results are in service 06', tests: [], records: [] };
  }
  const records: RequestRecord[] = [];
  const tests: O2TestResult['tests'] = [];
  for (const sensor of sensors) {
    for (const [tidS, meta] of Object.entries(MODE05_TIDS)) {
      const tid = Number(tidS);
      const rec = await ctx.runner.execute({ service: 0x05, params: [tid, sensor], purpose: 'monitor', maxAttempts: 1 });
      records.push(rec);
      for (const r of okResults(rec)) {
        const v = r.payload[3];
        tests.push({ ecu: r.ecu, tid, sensor, raw: toHex(r.payload), value: v === undefined ? null : v * meta.scale, unit: meta.unit, name: meta.name });
      }
    }
  }
  return { applicable: true, tests, records };
}
