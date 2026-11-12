import type { DtcDefs } from './types.ts';

export interface DtcInfo {
  code: string;
  system: 'P' | 'C' | 'B' | 'U';
  systemName: string;
  type: 'generic' | 'manufacturer';
  subsystem: string | null;
  title: string;
  /** True when the title came from the OBDCraft table rather than a generic fallback. */
  known: boolean;
  source: string;
}

const CODE_RE = /^[PCBU][0-3][0-9A-F]{3}$/;

/** Case-insensitive, like `classifyDtc`: "p0301" is the same code as "P0301". */
export function isDtcCode(code: string): boolean {
  return CODE_RE.test(code.toUpperCase());
}

export function classifyDtc(defs: DtcDefs, code: string): DtcInfo {
  const c = code.toUpperCase();
  if (!isDtcCode(c)) throw new Error(`not a DTC: ${code}`);
  const system = c[0] as DtcInfo['system'];
  const num = parseInt(c.slice(1), 16);
  let type: DtcInfo['type'] = 'manufacturer';
  for (const r of defs.generic_ranges) {
    if (r.from[0] !== system) continue;
    if (num >= parseInt(r.from.slice(1), 16) && num <= parseInt(r.to.slice(1), 16)) {
      type = r.type;
      break;
    }
  }
  const group = defs.subsystems[c.slice(0, 2)];
  const subsystem = type === 'generic' ? (group?.[c[2]!] ?? null) : null;
  const authored = defs.codes[c];
  const title = authored ?? (type === 'generic' ? defs.unknown_generic : defs.unknown_manufacturer);
  return {
    code: c,
    system,
    systemName: defs.systems[system]!,
    type,
    subsystem,
    title,
    known: authored !== undefined,
    source: authored ? 'Vibecode my car-authored description (CC0)' : 'classification only',
  };
}
