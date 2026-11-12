import type { Mode06Defs } from './types.ts';

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

export interface Mode06Scaling {
  uasid: string;
  scale: number;
  offset: number;
  signed: boolean;
  unit: string | null;
  label: string;
  /** How the scaling was found: table entry or the signed mirror rule. */
  basis: 'table' | 'signed_mirror' | 'unknown';
}

export function scalingFor(defs: Mode06Defs, uasid: number): Mode06Scaling {
  const id = hex2(uasid);
  const direct = defs.uasid[id];
  if (direct) {
    return { uasid: id, scale: direct.scale, offset: direct.offset ?? 0, signed: !!direct.signed, unit: direct.unit, label: direct.label, basis: 'table' };
  }
  if (uasid >= 0x81 && uasid <= 0xbf) {
    const m = defs.uasid[hex2(uasid - 0x80)];
    if (m) {
      // signed temperature (0x96) has no -40 offset; other mirrors keep none either
      return { uasid: id, scale: m.scale, offset: 0, signed: true, unit: m.unit, label: `${m.label} (signed)`, basis: 'signed_mirror' };
    }
  }
  return { uasid: id, scale: 1, offset: 0, signed: false, unit: null, label: 'unknown scaling (raw)', basis: 'unknown' };
}

export function midName(defs: Mode06Defs, mid: number): string {
  const id = hex2(mid);
  const n = defs.mids[id];
  if (n) return n;
  for (const r of defs.mid_ranges) if (mid >= parseInt(r.from, 16) && mid <= parseInt(r.to, 16)) return r.label;
  return `Monitor ${id} (not in table)`;
}

export function tidName(defs: Mode06Defs, mid: number, tid: number): { name: string; standard: boolean } {
  if (tid >= 0x80) return { name: `Manufacturer test ${hex2(tid)}`, standard: false };
  const isO2 = mid >= 0x01 && mid <= 0x10;
  const isMisfire = mid >= 0xa1 && mid <= 0xad;
  if ((isO2 && tid <= 0x0a) || (isMisfire && (tid === 0x0b || tid === 0x0c))) {
    const n = defs.tids[hex2(tid)];
    if (n) return { name: n, standard: true };
  }
  return { name: `Standard test ${hex2(tid)}`, standard: true };
}

export interface Mode06Test {
  mid: string;
  midName: string;
  tid: string;
  tidName: string;
  standardTid: boolean;
  scaling: Mode06Scaling;
  raw: { value: number; min: number; max: number };
  value: number;
  min: number;
  max: number;
  passed: boolean;
  /** 0 at min, 1 at max; null when the limits are equal. */
  position: number | null;
  /**
   * The raw value sits at the end of its range (0xFFFF, or 0x7FFF/0x8000 signed).
   * Many ECUs report that when the test has not run yet, so a "pass" here proves little.
   */
  saturated: boolean;
  bytesHex: string;
}

function scaled(raw: number, s: Mode06Scaling): number {
  const v = s.signed && raw >= 0x8000 ? raw - 0x10000 : raw;
  return v * s.scale + s.offset;
}

/** Decodes the 9-byte CAN records of one service 06 reply (bytes after 0x46). */
export function decodeMode06Records(defs: Mode06Defs, payload: ArrayLike<number>): { tests: Mode06Test[]; leftover: number } {
  const tests: Mode06Test[] = [];
  let i = 0;
  for (; i + 9 <= payload.length; i += 9) {
    const b = Array.from({ length: 9 }, (_, k) => payload[i + k]!);
    const [mid, tid, uasid, vh, vl, nh, nl, xh, xl] = b as [number, number, number, number, number, number, number, number, number];
    const s = scalingFor(defs, uasid);
    const raw = { value: vh * 256 + vl, min: nh * 256 + nl, max: xh * 256 + xl };
    const value = scaled(raw.value, s);
    const min = scaled(raw.min, s);
    const max = scaled(raw.max, s);
    const t = tidName(defs, mid, tid);
    tests.push({
      mid: hex2(mid), midName: midName(defs, mid), tid: hex2(tid), tidName: t.name, standardTid: t.standard,
      scaling: s, raw, value, min, max,
      passed: value >= min && value <= max,
      position: max === min ? null : (value - min) / (max - min),
      saturated: s.signed ? raw.value === 0x7fff || raw.value === 0x8000 : raw.value === 0xffff,
      bytesHex: b.map(hex2).join(' '),
    });
  }
  return { tests, leftover: payload.length - i };
}
