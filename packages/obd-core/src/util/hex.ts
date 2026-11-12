export const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

export const toHex = (bytes: ArrayLike<number>, sep = ' '): string => Array.from(bytes, hex2).join(sep);

/** "41 0C 1C 56" or "410C1C56" -> [0x41, 0x0C, 0x1C, 0x56]; null when not hex. */
export function parseHexBytes(s: string): number[] | null {
  const t = s.replace(/\s+/g, '');
  if (t.length === 0 || t.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(t)) return null;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
  return out;
}

export const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

export const fromAscii = (b: ArrayLike<number>): string => String.fromCharCode(...Array.from(b));

export const bytesToHexCompact = (b: ArrayLike<number>): string => toHex(b, '');
