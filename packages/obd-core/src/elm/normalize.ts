/** ELM327 status words that can appear instead of (or after) data lines. */
export const ELM_STATUS = [
  'NO DATA',
  'CAN ERROR',
  'BUS ERROR',
  'BUS BUSY',
  'BUFFER FULL',
  'DATA ERROR',
  'FB ERROR',
  'STOPPED',
  'UNABLE TO CONNECT',
  'LV RESET',
  'ACT ALERT',
  'ERR',
  '?',
] as const;

export type ElmStatus = (typeof ELM_STATUS)[number] | 'RX ERROR' | 'BUS INIT ERROR';

export interface NormalizedReply {
  /** Data or text lines, echo/SEARCHING/BUS INIT removed. */
  lines: string[];
  /** ELM status words found (NO DATA, CAN ERROR, ...). */
  statuses: ElmStatus[];
  echoSeen: boolean;
  searching: boolean;
}

const compact = (s: string) => s.replace(/\s+/g, '').toUpperCase();

export function normalizeReply(raw: string, cmd: string): NormalizedReply {
  const out: NormalizedReply = { lines: [], statuses: [], echoSeen: false, searching: false };
  const text = raw.replace(/\0/g, '').replace(/>/g, '');
  const cmdC = compact(cmd);
  for (const piece of text.split(/[\r\n]+/)) {
    let line = piece.trim();
    if (!line) continue;
    if (!out.echoSeen && out.lines.length === 0 && compact(line) === cmdC && cmdC.length > 0) {
      out.echoSeen = true;
      continue;
    }
    if (/^SEARCHING/i.test(line)) {
      out.searching = true;
      line = line.replace(/^SEARCHING\.*\s*/i, '');
      if (!line) continue;
    }
    if (/^BUS INIT/i.test(line)) {
      if (/ERROR/i.test(line)) out.statuses.push('BUS INIT ERROR');
      continue;
    }
    // "7E8 03 41 0D 00 <RX ERROR" or "<DATA ERROR": keep the data part, flag the error
    const err = /<\s*(RX|DATA) ERROR/i.exec(line);
    if (err) {
      out.statuses.push(err[1]!.toUpperCase() === 'RX' ? 'RX ERROR' : 'DATA ERROR');
      line = line.slice(0, err.index).trim();
      if (!line) continue;
    }
    const up = line.toUpperCase();
    const st = ELM_STATUS.find((s) => up === s || (s !== '?' && s !== 'ERR' && up.startsWith(s)) || (s === 'ERR' && /^ERR\d+/.test(up)));
    if (st) {
      out.statuses.push(st);
      continue;
    }
    out.lines.push(line);
  }
  return out;
}

/** True when the line looks like hex data (with or without spaces). */
export function isHexLine(line: string): boolean {
  return /^[0-9A-Fa-f ]+$/.test(line) && line.replace(/\s/g, '').length >= 2;
}
