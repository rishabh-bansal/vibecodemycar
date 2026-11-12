import { classifyDtc, DTC, decodePid, OBD, pidDefOrRaw, unitSymbol } from '@obdcraft/definitions';
import { assertHealthRequest } from './readonly.ts';

/**
 * UDS fault memory of one control unit, read only with ReadDTCInformation (19) and identity reads (22):
 *
 *   19 01 FF            how many entries have any status bit set (a single frame: survives any adapter)
 *   19 01 2D            how many entries are faults (see {@link FAULT_STATUS_MASK})
 *   19 02 2D            the fault list, 4 bytes per DTC (3 DTC bytes + status). Not `19 02 FF`: VW units answer FF
 *                       with every DTC whose status has any bit, including the many whose only bits are 10 / 40
 *                       ("test not completed"), which are not faults (a Kushaq listed 144 such entries in power
 *                       steering). Long lists are multi-frame and the live clone forwards at most ~4 consecutive
 *                       frames (34 bytes = 7 DTCs): a truncated list is reported as such ("truncated: got N of M
 *                       bytes") and then asked again split by status mask (08 confirmed, 04 pending, 01 test failed
 *                       now, 20 failed since the last clear), each part shorter; together they cover the whole mask
 *   19 04 <DTC> FF      every snapshot (freeze frame) record of one DTC
 *   19 06 <DTC> FF      every extended data record of one DTC (VW: priority, frequency counter, unlearning counter)
 *
 * Raw hex is always kept. Decoding is limited to what is standard (status bits, ISO 27145 F4xx = OBD PID snapshot
 * identifiers) plus the commonly documented VW fields, which are labelled "unverified": nothing here comes from VW
 * documentation, and a value that does not fit the expected layout stays raw.
 */

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hexOf = (bytes: readonly number[]) => bytes.map(hx).join('');

/** DTC status bits (ISO 14229-1 D.2), bit 0 first. */
export const DTC_STATUS_BITS: readonly { bit: number; id: string; text: string }[] = [
  { bit: 0x01, id: 'testFailed', text: 'test failed (failing now)' },
  { bit: 0x02, id: 'testFailedThisOperationCycle', text: 'failed this drive cycle' },
  { bit: 0x04, id: 'pendingDTC', text: 'pending' },
  { bit: 0x08, id: 'confirmedDTC', text: 'confirmed (stored)' },
  { bit: 0x10, id: 'testNotCompletedSinceLastClear', text: 'test not completed since the last clear' },
  { bit: 0x20, id: 'testFailedSinceLastClear', text: 'failed since the last clear' },
  { bit: 0x40, id: 'testNotCompletedThisOperationCycle', text: 'test not completed this drive cycle' },
  { bit: 0x80, id: 'warningIndicatorRequested', text: 'warning lamp requested' },
];

/**
 * The status bits that make a DTC a fault: testFailed 01 | pendingDTC 04 | confirmedDTC 08 | testFailedSinceLastClear
 * 20. An entry with none of them (only 10 / 40 "test not completed", 02, 80) is not a fault, whatever list it came in.
 */
export const FAULT_STATUS_MASK = 0x2d;

/** True when the status byte has one of the {@link FAULT_STATUS_MASK} bits. */
export const isFaultStatus = (status: number): boolean => (status & FAULT_STATUS_MASK) !== 0;

export type FaultClass = 'confirmed' | 'pending' | 'failing now' | 'failed since the last clear';

/**
 * What kind of fault a status byte says, the strongest bit first: confirmed 08, pending 04, failing now 01, failed
 * since the last clear 20 (and nothing else). Null when it is not a fault.
 */
export function faultClass(status: number): FaultClass | null {
  if (status & 0x08) return 'confirmed';
  if (status & 0x04) return 'pending';
  if (status & 0x01) return 'failing now';
  if (status & 0x20) return 'failed since the last clear';
  return null;
}

/** The DTCs of a unit's list that are faults (an old snapshot's `19 02 FF` list holds non-faults too). */
export const faultDtcs = (list: { dtcs: readonly UdsDtc[] }): UdsDtc[] =>
  list.dtcs.filter((d) => isFaultStatus(d.status));

/** The names of the status bits set in `status`. */
export function decodeDtcStatus(status: number): string[] {
  return DTC_STATUS_BITS.filter((b) => status & b.bit).map((b) => b.id);
}

/** Identity identifiers read on every reachable unit (the scan's identity set, trimmed to what a job card needs). */
export const IDENTITY_DIDS: readonly { did: string; field: string; label: string }[] = [
  { did: 'F187', field: 'part', label: 'part number' },
  { did: 'F189', field: 'software', label: 'software version' },
  { did: 'F191', field: 'hardware', label: 'hardware part number' },
  { did: 'F1A3', field: 'hardwareVersion', label: 'hardware version' },
  { did: 'F18C', field: 'serial', label: 'serial number' },
  { did: 'F197', field: 'system', label: 'system name' },
];

/**
 * Status masks the fault list is split by when the whole list arrives truncated: confirmed, pending, failing now,
 * failed since the last clear. Together they are {@link FAULT_STATUS_MASK}: whole splits are the whole fault list.
 */
export const SPLIT_MASKS: readonly { mask: number; label: string }[] = [
  { mask: 0x08, label: 'confirmed' },
  { mask: 0x04, label: 'pending' },
  { mask: 0x01, label: 'test failed now' },
  { mask: 0x20, label: 'failed since the last clear' },
];

/**
 * How long a 19 read keeps listening after the unit answered 78 response-pending: P2* is 5 s per renewal, and the
 * fault list of the brakes (713) and airbags (715) is only ready seconds after their `7F 19 78` (live 2026-11-09).
 */
export const DTC_PENDING_POLL_MS = 10_000;

/**
 * Per-request transport options of the health reads. A 19 read: an empty prompt (NO DATA) is final at once
 * (`pendingListenMs: 0`, no dead listen), but after a 78 the adapter is kept listening for the final answer by
 * polling with a silent tester present (`3E 80`, itself one of the allowed health requests) for
 * {@link DTC_PENDING_POLL_MS}. 22 reads keep the transport's own windows.
 */
export function healthRequestOptions(pdu: readonly number[]): {
  pendingListenMs?: number;
  pendingPollMs?: number;
} {
  return pdu[0] === 0x19 ? { pendingListenMs: 0, pendingPollMs: DTC_PENDING_POLL_MS } : {};
}

/** Sends of a request that got no answer at all, and of the presence read (F187) that decides "not reachable". */
export const NO_REPLY_ATTEMPTS = 2;
export const PRESENCE_ATTEMPTS = 3;

/** At most this many DTCs per unit get their snapshot and extended data read (each costs two requests). */
export const DETAIL_DTC_LIMIT = 16;

/** What one request returned, as the transport classified it. */
export type UdsAnswer =
  /** The whole positive response, service byte first. */
  | { kind: 'ok'; bytes: number[] }
  | { kind: 'nrc'; code: number }
  /** NO DATA or UNABLE TO CONNECT: nothing answered. */
  | { kind: 'no-reply'; adapter?: string }
  /** A multi-frame answer shorter than its first frame declared: `partial` bytes in order, `declared` total. */
  | { kind: 'truncated'; partial: number[]; declared: number | null }
  /** 7F xx 78 and the final answer never came. */
  | { kind: 'pending' }
  /** The link itself failed: the unit's read stops here. */
  | { kind: 'lost'; error: string };

export type UdsSend = (pdu: number[]) => Promise<UdsAnswer>;

/** A value that is either read or says why not; never invented. */
export type Field<T> = { status: 'ok'; value: T } | { status: 'not supported' | 'not read'; why: string };

export interface ReadIssue {
  request: string;
  answer: string;
}

export interface UdsSnapshotValue {
  did: string;
  hex: string;
  name?: string;
  value?: number | string;
  unit?: string;
  /** VW decodings are from common documentation, not from VW: they may be wrong. */
  unverified?: boolean;
}

export interface UdsSnapshotRecord {
  record: number;
  values: UdsSnapshotValue[];
  /** Bytes after the last identifier that could be split (unknown identifier length): kept raw. */
  undecodedHex?: string;
}

export interface UdsExtendedRecord {
  record: number;
  hex: string;
  value?: number;
  /** The commonly documented VW meaning of this record number (unverified). */
  name?: string;
  unverified?: boolean;
}

export interface UdsDetail<T> {
  status: 'ok' | 'not supported' | 'no answer' | 'truncated' | 'pending';
  raw?: string;
  note?: string;
  records?: T[];
}

export interface UdsDtc {
  /**
   * The display name: "VW 17142" (the 3 DTC bytes as one number, as VW testers print it). Snapshots taken before
   * 2026-11-09 hold an SAE J2012 reading here ("P0042"), which is wrong for VW units: display with
   * {@link udsDtcLabel}, which works from `dtcHex` and so renders old snapshots the new way.
   */
  code: string;
  /** The 3 DTC bytes as hex, e.g. "0042F6": the raw identity of the entry. */
  dtcHex: string;
  /** The DTC low byte, hex (kept raw; on VW units it is part of the DTC number, not an SAE failure type). */
  failureType: string;
  status: number;
  statusHex: string;
  statusBits: string[];
  meaning: string;
  snapshot?: UdsDetail<UdsSnapshotRecord>;
  extended?: UdsDetail<UdsExtendedRecord>;
}

export interface UdsDtcList {
  status: 'ok' | 'partial' | 'not supported' | 'no answer';
  /**
   * 19 01 FF: how many entries have any status bit set (faults and "test not completed" entries alike), when the
   * unit answered. Not a fault count: see `faultCount`.
   */
  count: number | null;
  /** 19 01 2D: how many entries are faults (snapshots before the fault mask do not have it). */
  faultCount?: number | null;
  /**
   * The status mask the list was asked with: "2D" (faults only). Snapshots without it asked FF and list
   * non-faults too: filter with {@link faultDtcs}.
   */
  listMask?: string;
  availabilityMask?: string;
  dtcs: UdsDtc[];
  /** "truncated: got 34 of 47 bytes" and what was done about it. */
  notes: string[];
  raw: string[];
}

export interface UnitHealth {
  unit: string;
  label: string;
  request: string;
  response: string;
  reachable: boolean;
  identity: Record<string, Field<string>>;
  faults: UdsDtcList;
  issues: ReadIssue[];
}

/** The generic SAE meaning from the built-in table, or an honest "unknown". For OBD modes 03 / 07 / 0A only. */
export function dtcMeaning(code: string): string {
  try {
    const info = classifyDtc(DTC, code);
    if (info.known) return info.title;
    return info.type === 'generic'
      ? 'meaning: unknown (generic code not in the built-in table)'
      : 'meaning: unknown (manufacturer-specific)';
  } catch {
    return 'meaning: unknown';
  }
}

export function describeAnswer(a: UdsAnswer): string {
  switch (a.kind) {
    case 'ok':
      return `ok ${hexOf(a.bytes)}`;
    case 'nrc':
      return `negative response ${hx(a.code)}`;
    case 'no-reply':
      return a.adapter ? `no answer (${a.adapter})` : 'no answer';
    case 'truncated':
      return truncationNote(a);
    case 'pending':
      return 'response pending, final answer never came';
    case 'lost':
      return `link lost: ${a.error}`;
  }
}

export function truncationNote(a: { partial: readonly number[]; declared: number | null }): string {
  return a.declared
    ? `truncated: got ${a.partial.length} of ${a.declared} bytes`
    : `truncated: got ${a.partial.length} bytes`;
}

/** Text of an identity answer: printable ASCII as text, anything else as hex. */
export function identityText(data: readonly number[]): string {
  const text = String.fromCharCode(...data)
    .replace(/\0+$/g, '')
    .trim();
  return text && /^[\x20-\x7e]+$/.test(text) ? text : hexOf(data);
}

/**
 * What a VW unit's DTC means is not known here. VW numbers its UDS DTCs internally (all 3 bytes as one number); the
 * workshop tester names them from VW's label files. Reading the bytes as an SAE P/B/C/U code gives a wrong code and
 * a wrong meaning (live 2026-11-09: engine 0042F6 read as "P0042", gateway 020273 as "P0202 injector cylinder 2").
 */
export const UDS_DTC_MEANING =
  "meaning: unknown (VW-internal DTC number; the workshop tester's label files name it)";

/** The VW DTC number: the 3 DTC bytes as one number (0042F6 → 17142). */
export const vwDtcNumber = (dtcHex: string): number => Number.parseInt(dtcHex, 16);

/** "VW 17142 (0x0042F6)": how a UDS unit's DTC is shown, never as an SAE code. Works on old snapshots too. */
export const udsDtcLabel = (d: { dtcHex: string }): string =>
  `VW ${vwDtcNumber(d.dtcHex)} (0x${d.dtcHex.toUpperCase().padStart(6, '0')})`;

/** "VW 17142 (0x0042F6) failed since the last clear". */
export const udsDtcText = (d: { dtcHex: string; status: number }): string =>
  `${udsDtcLabel(d)} ${faultClass(d.status) ?? 'not a fault'}`;

/** A remark on the DTC number itself, or null: FFFFxx entries look like placeholders rather than real faults. */
export const udsDtcRemark = (d: { dtcHex: string }): string | null =>
  /^FFFF/i.test(d.dtcHex) ? 'number FFFFxx: possibly a placeholder entry, not a real fault' : null;

/** One DTC record (3 DTC bytes + status). Never given an SAE code or meaning: see {@link UDS_DTC_MEANING}. */
export function udsDtcOf(record: readonly number[]): UdsDtc {
  const [hi = 0, mid = 0, low = 0, status = 0] = record;
  const dtcHex = hexOf([hi, mid, low]);
  return {
    code: `VW ${vwDtcNumber(dtcHex)}`,
    dtcHex,
    failureType: hx(low),
    status,
    statusHex: hx(status),
    statusBits: decodeDtcStatus(status),
    meaning: UDS_DTC_MEANING,
  };
}

/**
 * Parses `59 02 <mask> (DTC DTC DTC status)*`. Only whole 4-byte records are taken: a partial answer gives the
 * records that arrived complete, never a guessed one. Records of one repeated padding byte are frame filler.
 */
export function parseDtcList(bytes: readonly number[]): { mask: number; dtcs: UdsDtc[] } | null {
  if (bytes[0] !== 0x59 || bytes[1] !== 0x02 || bytes.length < 3) return null;
  const dtcs: UdsDtc[] = [];
  for (let i = 3; i + 4 <= bytes.length; i += 4) {
    const r = bytes.slice(i, i + 4);
    if (r.every((x) => x === r[0]) && (r[0] === 0x00 || r[0] === 0xaa || r[0] === 0x55 || r[0] === 0xff))
      continue;
    dtcs.push(udsDtcOf(r));
  }
  return { mask: bytes[2]!, dtcs };
}

/** Parses `59 01 <availability mask> <format> <count hi> <count lo>`. */
export function parseDtcCount(bytes: readonly number[]): number | null {
  if (bytes[0] !== 0x59 || bytes[1] !== 0x01 || bytes.length < 6) return null;
  return bytes[4]! * 256 + bytes[5]!;
}

/** VW snapshot identifiers with a commonly documented meaning (unverified) and their byte length. */
const VW_SNAPSHOT_DIDS: Readonly<Record<number, { name: string; bytes: number; unit?: string }>> = {
  8194: { name: 'mileage at the fault', bytes: 3, unit: 'km' },
};

/** VW extended data record numbers with a commonly documented meaning (unverified), each one byte. */
const VW_EXTENDED_RECORDS: Readonly<Record<number, string>> = {
  1: 'priority',
  2: 'malfunction frequency counter',
  3: 'unlearning counter',
};

/** One snapshot identifier's value: F4xx is the OBD PID xx (ISO 27145-2), 2002 the VW mileage (unverified). */
function snapshotValue(did: number, data: readonly number[]): UdsSnapshotValue {
  const value: UdsSnapshotValue = { did: hx(did >> 8) + hx(did & 0xff), hex: hexOf(data) };
  if (did >> 8 === 0xf4) {
    const def = pidDefOrRaw(did & 0xff);
    if (def && def.category !== 'unlisted') {
      const d = decodePid(OBD, def, data);
      const f = d.fields.find((x) => x.value !== null);
      if (d.lengthOk && f)
        return {
          ...value,
          name: f.name,
          value: f.value ?? undefined,
          ...(f.unit ? { unit: unitSymbol(f.unit) } : {}),
        };
    }
    return value;
  }
  const vw = VW_SNAPSHOT_DIDS[did];
  if (vw && data.length === vw.bytes) {
    return {
      ...value,
      name: vw.name,
      value: data.reduce((n, b) => n * 256 + b, 0),
      ...(vw.unit ? { unit: vw.unit } : {}),
      unverified: true,
    };
  }
  return value;
}

/** Byte length of a snapshot identifier's data, when known; undefined stops the split (the rest stays raw). */
function snapshotLength(did: number): number | undefined {
  if (did >> 8 === 0xf4) {
    const def = pidDefOrRaw(did & 0xff);
    return def && def.category !== 'unlisted' && def.lengths.length === 1 ? def.lengths[0] : undefined;
  }
  return VW_SNAPSHOT_DIDS[did]?.bytes;
}

/**
 * Parses `59 04 <DTC 3> <status> (record <count> (DID DID data…)…)…`. Identifier data lengths are not in the answer,
 * so the split goes only as far as the identifiers are known; the rest of the record is kept raw.
 */
export function parseSnapshot(bytes: readonly number[]): UdsSnapshotRecord[] | null {
  if (bytes[0] !== 0x59 || bytes[1] !== 0x04 || bytes.length < 6) return null;
  const records: UdsSnapshotRecord[] = [];
  let i = 6;
  while (i + 1 < bytes.length) {
    const record = bytes[i]!;
    const count = bytes[i + 1]!;
    const rec: UdsSnapshotRecord = { record, values: [] };
    records.push(rec);
    i += 2;
    for (let n = 0; n < count; n++) {
      if (i + 2 > bytes.length) break;
      const did = bytes[i]! * 256 + bytes[i + 1]!;
      const len = snapshotLength(did);
      if (len === undefined || i + 2 + len > bytes.length) {
        rec.undecodedHex = hexOf(bytes.slice(i));
        return records;
      }
      rec.values.push(snapshotValue(did, bytes.slice(i + 2, i + 2 + len)));
      i += 2 + len;
    }
  }
  return records;
}

/**
 * Parses `59 06 <DTC 3> <status> (record data…)…`. Record lengths are not in the answer: the records are split only
 * when the rest reads as one-byte records with rising record numbers (the common VW layout); otherwise one raw block.
 */
export function parseExtended(bytes: readonly number[]): UdsExtendedRecord[] | null {
  if (bytes[0] !== 0x59 || bytes[1] !== 0x06 || bytes.length < 6) return null;
  const rest = bytes.slice(6);
  if (!rest.length) return [];
  const pairs = rest.length % 2 === 0 && rest.every((b, i) => i % 2 === 1 || i === 0 || b > rest[i - 2]!);
  if (!pairs) return [{ record: rest[0]!, hex: hexOf(rest.slice(1)) }];
  const out: UdsExtendedRecord[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const record = rest[i]!;
    const value = rest[i + 1]!;
    const name = VW_EXTENDED_RECORDS[record];
    out.push({ record, hex: hx(value), value, ...(name ? { name, unverified: true } : {}) });
  }
  return out;
}

/** A send that refuses anything but the health snapshot's reads before the transport sees it. */
export function guardedSend(send: UdsSend): UdsSend {
  return async (pdu) => {
    assertHealthRequest(pdu);
    return send(pdu);
  };
}

const hexBytes = (h: string) => (h.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));

/**
 * Reads one unit: identity, the DTC count and list (split by status mask when truncated), then each DTC's snapshot
 * and extended data. A unit that never answers is `reachable: false`. Every request passes {@link assertHealthRequest}.
 */
export async function readUnitHealth(
  unit: { unit: string; label: string; request: string; response: string },
  rawSend: UdsSend,
): Promise<UnitHealth> {
  const send = guardedSend(rawSend);
  const out: UnitHealth = {
    ...unit,
    reachable: false,
    identity: {},
    faults: { status: 'no answer', count: null, dtcs: [], notes: [], raw: [] },
    issues: [],
  };
  let lost = false;
  const ask = async (pdu: number[], attempts = NO_REPLY_ATTEMPTS): Promise<UdsAnswer> => {
    if (lost) return { kind: 'lost', error: 'the link was lost earlier in this unit' };
    let a = await send(pdu);
    // The clone drops a request now and then (NO DATA, or a failed search): asked again before it counts.
    for (let i = 1; i < attempts && a.kind === 'no-reply'; i++) a = await send(pdu);
    if (a.kind === 'lost') lost = true;
    if (a.kind !== 'no-reply' && a.kind !== 'lost') out.reachable = true;
    if (a.kind !== 'ok') out.issues.push({ request: hexOf(pdu), answer: describeAnswer(a) });
    return a;
  };

  for (const { did, field } of IDENTITY_DIDS) {
    const a = await ask([0x22, ...hexBytes(did)], did === 'F187' ? PRESENCE_ATTEMPTS : NO_REPLY_ATTEMPTS);
    if (a.kind === 'ok') out.identity[field] = { status: 'ok', value: identityText(a.bytes.slice(3)) };
    else if (a.kind === 'nrc')
      out.identity[field] = { status: 'not supported', why: `negative response ${hx(a.code)}` };
    else out.identity[field] = { status: 'not read', why: describeAnswer(a) };
    // A unit silent on its part number (the scan's presence probe) is asked nothing more.
    if (did === 'F187' && !out.reachable) return out;
    if (lost) return out;
  }

  const count = await ask([0x19, 0x01, 0xff]);
  if (count.kind === 'ok') out.faults.count = parseDtcCount(count.bytes);
  if (count.kind === 'ok') out.faults.raw.push(hexOf(count.bytes));
  const faultCount = await ask([0x19, 0x01, FAULT_STATUS_MASK]);
  out.faults.faultCount = faultCount.kind === 'ok' ? parseDtcCount(faultCount.bytes) : null;
  if (faultCount.kind === 'ok') out.faults.raw.push(hexOf(faultCount.bytes));

  out.faults.listMask = hx(FAULT_STATUS_MASK);
  const list = await ask([0x19, 0x02, FAULT_STATUS_MASK]);
  const add = (dtcs: UdsDtc[]) => {
    for (const d of dtcs) if (!out.faults.dtcs.some((x) => x.dtcHex === d.dtcHex)) out.faults.dtcs.push(d);
  };
  if (list.kind === 'ok') {
    const parsed = parseDtcList(list.bytes);
    out.faults.raw.push(hexOf(list.bytes));
    if (parsed) {
      out.faults.status = 'ok';
      out.faults.availabilityMask = hx(parsed.mask);
      add(parsed.dtcs);
    } else out.faults.notes.push(`19 02 answer not understood: ${hexOf(list.bytes)}`);
  } else if (list.kind === 'nrc') {
    out.faults.status = 'not supported';
    out.faults.notes.push(`19 02 refused: negative response ${hx(list.code)}`);
  } else if (list.kind === 'truncated') {
    out.faults.status = 'partial';
    out.faults.raw.push(hexOf(list.partial));
    out.faults.notes.push(`19 02 2D ${truncationNote(list)}; asked again split by status mask`);
    const whole = parseDtcList(list.partial);
    if (whole) out.faults.availabilityMask = hx(whole.mask);
    let complete = true;
    for (const { mask, label } of SPLIT_MASKS) {
      const part = await ask([0x19, 0x02, mask]);
      if (part.kind === 'ok') {
        const parsed = parseDtcList(part.bytes);
        out.faults.raw.push(hexOf(part.bytes));
        if (parsed) add(parsed.dtcs);
      } else if (part.kind === 'truncated') {
        complete = false;
        out.faults.raw.push(hexOf(part.partial));
        out.faults.notes.push(
          `19 02 ${hx(mask)} (${label}) ${truncationNote(part)}: only the DTCs that arrived whole are listed`,
        );
        add(parseDtcList(part.partial)?.dtcs ?? []);
      } else {
        complete = false;
        out.faults.notes.push(`19 02 ${hx(mask)} (${label}): ${describeAnswer(part)}`);
      }
      if (lost) break;
    }
    // The records of the truncated whole list that arrived complete are real too (the split may have missed them).
    add(whole?.dtcs ?? []);
    // 08 | 04 | 01 | 20 is the whole fault mask: whole splits are the whole fault list.
    if (complete && !lost) {
      out.faults.status = 'ok';
      out.faults.notes.push('the split lists (08, 04, 01, 20) arrived whole: the fault list is complete');
    }
  } else {
    out.faults.notes.push(`19 02: ${describeAnswer(list)}`);
  }
  const faults = faultDtcs(out.faults);
  if (out.faults.dtcs.length > faults.length) {
    out.faults.notes.push(
      `${out.faults.dtcs.length - faults.length} listed entr${out.faults.dtcs.length - faults.length === 1 ? 'y has' : 'ies have'} no fault bit (unit ignored the mask): kept, not counted as faults`,
    );
  }
  if (out.faults.faultCount != null && out.faults.faultCount > faults.length) {
    out.faults.notes.push(`the unit counts ${out.faults.faultCount} fault(s), ${faults.length} listed`);
  }

  for (const dtc of faults.slice(0, DETAIL_DTC_LIMIT)) {
    if (lost) break;
    const id = hexBytes(dtc.dtcHex);
    dtc.snapshot = await detail(ask, [0x19, 0x04, ...id, 0xff], parseSnapshot);
    dtc.extended = await detail(ask, [0x19, 0x06, ...id, 0xff], parseExtended);
  }
  if (faults.length > DETAIL_DTC_LIMIT) {
    out.faults.notes.push(`snapshot and extended data read for the first ${DETAIL_DTC_LIMIT} DTCs only`);
  }
  return out;
}

async function detail<T>(
  ask: (pdu: number[]) => Promise<UdsAnswer>,
  pdu: number[],
  parse: (bytes: readonly number[]) => T[] | null,
): Promise<UdsDetail<T>> {
  const a = await ask(pdu);
  if (a.kind === 'ok') {
    const records = parse(a.bytes);
    return records
      ? { status: 'ok', raw: hexOf(a.bytes), records }
      : { status: 'ok', raw: hexOf(a.bytes), note: 'layout not understood: raw only' };
  }
  if (a.kind === 'truncated') {
    const records = parse(a.partial);
    return {
      status: 'truncated',
      raw: hexOf(a.partial),
      note: truncationNote(a),
      ...(records ? { records } : {}),
    };
  }
  if (a.kind === 'nrc') return { status: 'not supported', note: `negative response ${hx(a.code)}` };
  if (a.kind === 'pending') return { status: 'pending', note: describeAnswer(a) };
  return { status: 'no answer', note: describeAnswer(a) };
}
