import { parseHexBytes } from '../util/hex.ts';

export type ProtocolFamily = 'can11' | 'can29' | 'legacy' | 'unknown';

export interface ProtocolInfo {
  /** ELM protocol number 1-C (0 = not yet known). */
  number: number;
  auto: boolean;
  name: string;
  family: ProtocolFamily;
}

const PROTOCOLS: Record<string, [string, ProtocolFamily]> = {
  '1': ['SAE J1850 PWM (41.6 kbaud)', 'legacy'],
  '2': ['SAE J1850 VPW (10.4 kbaud)', 'legacy'],
  '3': ['ISO 9141-2 (5 baud init)', 'legacy'],
  '4': ['ISO 14230-4 KWP (5 baud init)', 'legacy'],
  '5': ['ISO 14230-4 KWP (fast init)', 'legacy'],
  '6': ['ISO 15765-4 CAN (11 bit ID, 500 kbaud)', 'can11'],
  '7': ['ISO 15765-4 CAN (29 bit ID, 500 kbaud)', 'can29'],
  '8': ['ISO 15765-4 CAN (11 bit ID, 250 kbaud)', 'can11'],
  '9': ['ISO 15765-4 CAN (29 bit ID, 250 kbaud)', 'can29'],
  A: ['SAE J1939 CAN (29 bit ID, 250 kbaud)', 'can29'],
  B: ['User1 CAN (11 bit ID, 125 kbaud)', 'can11'],
  C: ['User2 CAN (11 bit ID, 50 kbaud)', 'can11'],
};

/** Parses the reply to ATDPN ("A6", "6", "A7" ...). */
export function parseProtocol(dpn: string): ProtocolInfo {
  const t = dpn.trim().toUpperCase();
  const auto = t.startsWith('A') && t.length === 2;
  const code = auto ? t[1]! : t[0] ?? '0';
  const p = PROTOCOLS[code];
  if (!p) return { number: 0, auto, name: 'unknown', family: 'unknown' };
  return { number: parseInt(code, 16), auto, name: p[0], family: p[1] };
}

export interface Frame {
  /** Header as shown by the ELM ("7E8", "18DAF110", "486B10"). */
  header: string;
  /** Responding ECU: CAN 11-bit header, 29-bit header, or legacy source byte. */
  ecu: string;
  /** CAN: PCI + data bytes (8 with padding). Legacy: data bytes, checksum removed. */
  bytes: number[];
  raw: string;
}

export interface FrameParseContext {
  family: ProtocolFamily;
  headers: boolean;
}

/**
 * One ELM line -> one frame. Works with spaces on and off (ATS0).
 * Returns null for lines that are not frames (text, malformed).
 */
export function parseFrameLine(line: string, ctx: FrameParseContext): Frame | null {
  const raw = line.trim();
  const spaced = raw.includes(' ');
  const parts = spaced ? raw.split(/\s+/) : null;
  if (!ctx.headers) {
    const bytes = parseHexBytes(raw);
    return bytes ? { header: '', ecu: '?', bytes, raw } : null;
  }
  if (ctx.family === 'can11' || (ctx.family === 'unknown' && (spaced ? parts![0]!.length === 3 : raw.length % 2 === 1))) {
    // Some ELM adapters display an 11-bit responder as four zero-padded byte tokens.
    // Compare the full numeric ID; never alias a genuine extended ID onto its low 11 bits.
    const wideTokens = spaced && parts![0]!.length === 8 ? 1 : 4;
    const wide = spaced && wideTokens === 1 ? parts![0]! : spaced && parts!.length >= 5 && parts!.slice(0, 4).every(p => /^[0-9A-Fa-f]{2}$/.test(p))
      ? parts!.slice(0, 4).join('') : !spaced && raw.length % 2 === 0 ? raw.slice(0, 8) : '';
    if (/^00000[0-7][0-9A-Fa-f]{2}$/.test(wide)) {
      const bytes = parseHexBytes(spaced ? parts!.slice(wideTokens).join('') : raw.slice(8));
      if (!bytes) return null;
      const h = Number.parseInt(wide, 16).toString(16).toUpperCase().padStart(3, '0');
      return { header: h, ecu: h, bytes, raw };
    }
    const head = spaced ? parts![0]! : raw.slice(0, 3);
    const rest = spaced ? parts!.slice(1).join('') : raw.slice(3);
    if (!/^[0-9A-Fa-f]{3}$/.test(head)) return null;
    const bytes = parseHexBytes(rest);
    if (!bytes) return null;
    const h = head.toUpperCase();
    return { header: h, ecu: h, bytes, raw };
  }
  if (ctx.family === 'can29' || (ctx.family === 'unknown' && /^18\s?D[AB]/i.test(raw))) {
    const all = parseHexBytes(raw);
    if (!all || all.length < 5) return null;
    const h = all.slice(0, 4).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    return { header: h, ecu: h, bytes: all.slice(4), raw };
  }
  // legacy: 3 header bytes, data, checksum
  const all = parseHexBytes(raw);
  if (!all || all.length < 5) return null;
  const h = all.slice(0, 3).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  return { header: h, ecu: h.slice(4, 6), bytes: all.slice(3, -1), raw };
}
