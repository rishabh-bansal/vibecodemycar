import obdJson from '../data/obd.json' with { type: 'json' };
import mode06Json from '../data/mode06.json' with { type: 'json' };
import dtcJson from '../data/dtc.json' with { type: 'json' };
import type { DtcDefs, Mode06Defs, ObdDefinitions, PidDef, FieldDef } from './types.ts';

export * from './types.ts';
export * from './expr.ts';
export * from './decode.ts';
export { classifyDtc, isDtcCode, type DtcInfo } from './dtc.ts';
export * from './mode06.ts';
export * from './beginner.ts';

export const OBD = obdJson as unknown as ObdDefinitions;
export const MODE06 = mode06Json as unknown as Mode06Defs;
export const DTC = dtcJson as unknown as DtcDefs;

const byPid = new Map<number, PidDef>(OBD.pids.map((p) => [parseInt(p.pid, 16), p]));
const byKey = new Map<string, { pid: PidDef; field: FieldDef }>();
for (const p of OBD.pids) for (const f of p.fields) byKey.set(f.key, { pid: p, field: f });

export function pidDef(pid: number): PidDef | undefined {
  return byPid.get(pid);
}

/**
 * The definition for a PID, or a raw-bytes stand-in for one OBDCraft has no
 * table entry for (manufacturer-specific or newer PIDs), so nothing a car
 * advertises is silently skipped. Support pages (00, 20 ...) are never synthesized.
 */
export function pidDefOrRaw(pid: number): PidDef | undefined {
  const known = byPid.get(pid);
  if (known || pid % 0x20 === 0 || pid < 0 || pid > 0xff) return known;
  const h = pid.toString(16).toUpperCase().padStart(2, '0');
  return {
    pid: h, services: ['01', '02'], name: `PID ${h} (not in Vibecode my car's tables)`, short: `PID ${h}`, category: 'unlisted', kind: 'data',
    lengths: [], multi_pid: false, confidence: 'unlisted', source: 'advertised by the car; no public definition known to Vibecode my car',
    fields: [{ id: 'raw', key: `pid_${h.toLowerCase()}_raw`, name: `PID ${h}, raw bytes`, short: `PID ${h}`, formula: '', unit: null, kind: 'raw', min: null, max: null, requires_length: null, mask_bit: null, na_when: null }],
  };
}

export function fieldByKey(key: string): { pid: PidDef; field: FieldDef } | undefined {
  return byKey.get(key);
}

export function unitSymbol(unit: string | null): string {
  if (!unit) return '';
  return OBD.units[unit]?.symbol ?? unit;
}

export function isSupportPid(pid: number): boolean {
  return pid % 0x20 === 0;
}
