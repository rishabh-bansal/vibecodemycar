import { compile, substitute } from './expr.ts';
import type { DecodedField, DecodedPid, FieldDef, FormulaBreakdown, ObdDefinitions, PidDef } from './types.ts';

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface DecodeContext {
  /** From PID 01 byte B bit 3; selects the readiness bit names. */
  engineType?: 'spark' | 'compression';
}

export function roundForDisplay(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
}

function breakdown(f: FieldDef, data: ArrayLike<number>, value: number | null): FormulaBreakdown {
  const c = compile(f.formula);
  return {
    formula: f.formula,
    bytes: c.bytes.map((i) => ({ letter: LETTERS[i]!, hex: data[i] === undefined ? '--' : hex2(data[i]!), dec: data[i] ?? NaN })),
    substituted: substituteSafe(f.formula, data),
    result: value === null ? '-' : roundForDisplay(value),
  };
}

function substituteSafe(formula: string, data: ArrayLike<number>): string {
  try {
    return substitute(compile(formula).ast, data);
  } catch {
    return formula;
  }
}

export function bitNames(value: number, names: Record<string, string> | string[] | undefined): string[] {
  const out: string[] = [];
  for (let b = 0; b < 32; b++) {
    if (Math.floor(value / 2 ** b) % 2 !== 1) continue;
    const n = Array.isArray(names) ? names[b] : names?.[String(b)];
    out.push(n ?? `bit ${b}`);
  }
  return out;
}

export function dtcFromBytes(hi: number, lo: number): string {
  const sys = 'PCBU'[hi >> 6]!;
  return `${sys}${(hi >> 4) & 3}${(hi & 15).toString(16).toUpperCase()}${hex2(lo)}`;
}

/**
 * Bounds are published rounded to the digits they show (e.g. max 127.996 for a full scale of
 * 127.99609375): allow half a unit of the last shown digit, so a full-scale reading is in range.
 */
function slack(bound: number): number {
  const decimals = (String(bound).split('.')[1] ?? '').length;
  return Math.max(1e-9, 0.5 * 10 ** -decimals);
}

export function decodeField(
  defs: ObdDefinitions,
  pid: PidDef,
  f: FieldDef,
  data: ArrayLike<number>,
  ctx: DecodeContext = {},
): DecodedField {
  const base = { key: f.key, id: f.id, name: f.name, short: f.short, unit: f.unit, kind: f.kind };
  if (f.kind === 'raw') {
    const all = Array.from(data);
    return {
      ...base, value: null, state: all.length ? 'ok' : 'absent', text: all.length ? all.map(hex2).join(' ') : '',
      breakdown: { formula: 'raw bytes (no published formula)', bytes: all.map((b, i) => ({ letter: LETTERS[i] ?? '?', hex: hex2(b), dec: b })), substituted: '', result: '-' },
    };
  }
  if (f.requires_length !== null && data.length < f.requires_length) {
    return { ...base, value: null, state: 'absent', breakdown: breakdown(f, data, null) };
  }
  if (f.mask_bit !== null && pid.mask) {
    const maskIdx = pid.mask.byte.charCodeAt(0) - 65;
    const m = data[maskIdx] ?? 0;
    if (Math.floor(m / 2 ** f.mask_bit) % 2 !== 1) {
      return { ...base, value: null, state: 'absent', breakdown: breakdown(f, data, null) };
    }
  }
  const c = compile(f.formula);
  if (c.maxByte >= data.length) {
    return { ...base, value: null, state: 'absent', breakdown: breakdown(f, data, null) };
  }
  const value = c.run(data);
  if (!Number.isFinite(value)) {
    // e.g. a division by a zero byte: there is no reading to show
    return { ...base, value: null, state: 'not_available', text: 'not computable', breakdown: breakdown(f, data, null) };
  }
  if (f.na_when && compile(f.na_when).run(data)) {
    return { ...base, value: null, state: 'not_available', text: 'not used', breakdown: breakdown(f, data, value) };
  }
  const out: DecodedField = { ...base, value, state: 'ok', breakdown: breakdown(f, data, value) };
  if (f.min !== null && f.max !== null && (value < f.min - slack(f.min) || value > f.max + slack(f.max)))
    out.state = 'out_of_range';
  switch (f.kind) {
    case 'flag':
      out.text = value ? 'yes' : 'no';
      break;
    case 'enum':
      out.text = f.values?.[String(value)] ?? `unknown value ${value}`;
      break;
    case 'bitmask':
      out.setBits = bitNames(value, f.bits);
      out.text = out.setBits.length ? out.setBits.join(', ') : 'none';
      break;
    case 'readiness': {
      const names = ctx.engineType === 'compression' ? defs.readiness.compression : defs.readiness.spark;
      out.setBits = bitNames(value, names);
      out.text = out.setBits.length ? out.setBits.join(', ') : 'none';
      break;
    }
    case 'dtc':
      out.text = value === 0 ? 'none' : dtcFromBytes(Math.floor(value / 256), value % 256);
      break;
    case 'support_bitmap': {
      const base0 = parseInt(pid.pid, 16);
      const list: string[] = [];
      for (let i = 0; i < 32; i++) if (Math.floor(value / 2 ** (31 - i)) % 2 === 1) list.push(hex2(base0 + i + 1));
      out.setBits = list;
      out.text = list.join(' ');
      break;
    }
    default:
      break;
  }
  return out;
}

export function decodePid(defs: ObdDefinitions, pid: PidDef, data: ArrayLike<number>, ctx: DecodeContext = {}): DecodedPid {
  const dataHex = Array.from(data, hex2).join(' ');
  const lengthOk = pid.lengths.includes(data.length);
  // raw-only PIDs show whatever the car sent: their published byte count is not a formula
  const rawOnly = pid.fields.length > 0 && pid.fields.every((f) => f.kind === 'raw');
  let engineType = ctx.engineType;
  if (pid.pid === '01' && data.length >= 2) engineType = (data[1]! >> 3) & 1 ? 'compression' : 'spark';
  if (!lengthOk && !rawOnly) {
    return {
      pid: pid.pid, name: pid.name, status: 'length_mismatch', lengthOk, expectedLengths: pid.lengths, dataHex, fields: [],
      confidence: pid.confidence,
      error: `expected ${pid.lengths.join(' or ')} data bytes, got ${data.length}`,
    };
  }
  const fields = pid.fields.map((f) => decodeField(defs, pid, f, data, { engineType }));
  return { pid: pid.pid, name: pid.name, status: 'decoded', lengthOk, expectedLengths: pid.lengths, dataHex, fields, confidence: pid.confidence };
}
