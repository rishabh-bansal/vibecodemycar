import { dtcFromBytes } from '@obdcraft/definitions';
import { hex2 } from '../util/hex.ts';

/**
 * Decoding of DTC-read replies from any module, whatever service asked for them.
 *
 *   43 / 47 / 4A   OBD-II stored / pending / permanent. CAN: count byte, then 2 bytes per code;
 *                  legacy buses: no count byte, 2 bytes per code, padded with 0000.
 *   53 / 57 / 58   KWP2000 (13 / 17 / 18). A count byte, then 2 bytes per code, or 3 (code + status).
 *                  Which one is decided by the count: only a layout the length fits exactly is accepted.
 *   59             UDS 19 ReadDTCInformation: sub-function, status-availability mask, then 4-byte records
 *                  (high, middle, failure type, status). The failure type is appended: "P0133-1C".
 *
 * The reply is searched for its service id rather than assumed at byte 0: CAN ids, 29-bit header bytes and
 * ISO-TP PCI bytes sit in front, and they differ by adapter settings and module.
 */

export type DtcFormat = 'obd' | 'kwp' | 'uds';

export interface ReplyDtc {
  /** 5 characters ("P0133"); UDS records carry the failure type: "P0133-1C". */
  code: string;
  /** Status byte, when the reply carries one. */
  status?: number;
}

export interface DtcReply {
  sid: number;
  format: DtcFormat;
  codes: ReplyDtc[];
  /** What the reply says it holds (count byte / UDS count reply), when it says. */
  declaredCount: number | null;
  /** Which record layout matched ("count+2", "count+3", "no-count", "uds-4"). */
  layout: string;
  /** Index of the service id in the bytes given. */
  offset: number;
}

export interface NegativeReply {
  service: number;
  nrc: number;
}

const OBD_SIDS = new Set([0x43, 0x47, 0x4a]);
const KWP_SIDS = new Set([0x53, 0x57, 0x58]);
const PAD = new Set([0x00, 0x55, 0xaa, 0xff]);

const onlyPadding = (b: number[], from: number) => b.slice(from).every((x) => PAD.has(x));

function pairs(b: number[], from: number, n: number, width: 2 | 3): ReplyDtc[] {
  const out: ReplyDtc[] = [];
  for (let i = 0; i < n; i++) {
    const at = from + i * width;
    const code = dtcFromBytes(b[at]!, b[at + 1]!);
    out.push(width === 3 ? { code, status: b[at + 2]! } : { code });
  }
  return out;
}

function decodeObd(sid: number, rest: number[], can: boolean, offset: number): DtcReply | null {
  if (can) {
    const n = rest[0];
    if (n === undefined || rest.length < 1 + 2 * n || !onlyPadding(rest, 1 + 2 * n)) return null;
    return { sid, format: 'obd', codes: pairs(rest, 1, n, 2), declaredCount: n, layout: 'count+2', offset };
  }
  const codes: ReplyDtc[] = [];
  for (let i = 0; i + 1 < rest.length; i += 2) {
    if (rest[i] === 0 && rest[i + 1] === 0) continue;
    codes.push({ code: dtcFromBytes(rest[i]!, rest[i + 1]!) });
  }
  return { sid, format: 'obd', codes, declaredCount: null, layout: 'no-count', offset };
}

function decodeKwp(sid: number, rest: number[], offset: number): DtcReply | null {
  const n = rest[0];
  if (n === undefined) return null;
  if (n === 0) return onlyPadding(rest, 1) ? { sid, format: 'kwp', codes: [], declaredCount: 0, layout: 'count+2', offset } : null;
  if (rest.length >= 1 + 2 * n && onlyPadding(rest, 1 + 2 * n)) return { sid, format: 'kwp', codes: pairs(rest, 1, n, 2), declaredCount: n, layout: 'count+2', offset };
  if (rest.length >= 1 + 3 * n && onlyPadding(rest, 1 + 3 * n)) return { sid, format: 'kwp', codes: pairs(rest, 1, n, 3), declaredCount: n, layout: 'count+3', offset };
  return null;
}

/** Sub-functions of 19 whose reply is a list of 4-byte records after the availability mask. */
const UDS_LIST_SUBS = new Set([0x02, 0x0a, 0x0f, 0x13, 0x15, 0x17, 0x18, 0x19]);

function decodeUds(rest: number[], offset: number): DtcReply | null {
  const sub = rest[0];
  if (sub === undefined) return null;
  const s = sub & 0x7f;
  if (s === 0x01 || s === 0x07) {
    // count replies: mask, format identifier, count (2 bytes)
    if (rest.length < 5) return null;
    const count = rest[3]! * 256 + rest[4]!;
    return { sid: 0x59, format: 'uds', codes: [], declaredCount: count, layout: 'uds-count', offset };
  }
  if (!UDS_LIST_SUBS.has(s) || rest.length < 2) return null;
  const records = rest.slice(2);
  const n = Math.floor(records.length / 4);
  if (!onlyPadding(records, n * 4)) return null;
  const codes: ReplyDtc[] = [];
  for (let i = 0; i < n; i++) {
    const r = records.slice(i * 4, i * 4 + 4);
    // a record of one repeated padding byte (00 00 00 00, 55 55 55 55 ...) fills out the frame; it is not a code
    if (r.every((x) => x === r[0] && PAD.has(x))) continue;
    codes.push({ code: `${dtcFromBytes(r[0]!, r[1]!)}-${hex2(r[2]!)}`, status: r[3]! });
  }
  return { sid: 0x59, format: 'uds', codes, declaredCount: null, layout: 'uds-4', offset };
}

export interface DecodeOptions {
  /** CAN framing (count byte in 43/47/4A). Default true; pass false for J1850 / K-line. */
  can?: boolean;
}

/** Decodes the first DTC reply found in the bytes, or null when none is there. */
export function decodeDtcReply(bytes: number[], opts: DecodeOptions = {}): DtcReply | null {
  const can = opts.can ?? true;
  for (let i = 0; i < bytes.length; i++) {
    const sid = bytes[i]!;
    const rest = bytes.slice(i + 1);
    let r: DtcReply | null = null;
    if (OBD_SIDS.has(sid)) r = decodeObd(sid, rest, can, i);
    else if (KWP_SIDS.has(sid)) r = decodeKwp(sid, rest, i);
    else if (sid === 0x59) r = decodeUds(rest, i);
    if (r) return r;
  }
  return null;
}

/** A negative response "7F service code" anywhere in the bytes. */
export function findNegative(bytes: number[]): NegativeReply | null {
  for (let i = 0; i + 2 < bytes.length; i++) if (bytes[i] === 0x7f && bytes[i + 1] !== 0x7f) return { service: bytes[i + 1]!, nrc: bytes[i + 2]! };
  return null;
}

/**
 * Bytes of an ELM reply, header and PCI bytes included. Tokens of two hex digits are bytes; a 3-digit
 * token is an 11-bit CAN id and is dropped; "0:" multi-frame prefixes are removed. Lines without
 * spaces (ATS0) are read as a bare byte string, minus an 11-bit id (odd length) or a 29-bit id ("18DA...").
 */
export function replyBytes(lines: string[]): number[] {
  const out: number[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^\s*[0-9A-F]:\s*/i, '').trim();
    if (!line || /[^0-9A-Fa-f\s]/.test(line)) continue;
    if (/\s/.test(line)) {
      for (const t of line.split(/\s+/)) {
        if (t.length === 2) out.push(parseInt(t, 16));
        else if (t.length > 3 && t.length % 2 === 0) for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
      }
    } else {
      let s = line;
      if (s.length % 2 === 1) s = s.slice(3);
      else if (/^18DA/i.test(s) && s.length >= 8) s = s.slice(8);
      for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
    }
  }
  return out;
}
