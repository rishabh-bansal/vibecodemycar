/**
 * Simulated ECUs for the ELM327 emulator. An ECU turns a request payload into a
 * response payload (service byte first), or stays silent.
 */
export interface EcuModel {
  /** Response CAN id, e.g. "7E8". */
  readonly id: string;
  /** Physical request id, e.g. "7E0". */
  readonly requestId: string;
  /** Padding byte this ECU uses in CAN frames (7E8 pads 00, 7E9 pads AA on the Kushaq). */
  readonly pad: number;
  /** Typical reply latency in ms. */
  readonly latencyMs: number;
  /** null = no answer. */
  handle(req: number[], t: number, physical: boolean): number[] | null;
}

export type ValueSource = (tSeconds: number) => number[];

export interface DtcSet {
  stored: string[];
  pending: string[];
  /** null = the ECU does not answer service 0A (adapter shows NO DATA). */
  permanent: string[] | null;
}

export interface FreezeFrame {
  dtc: string;
  values: Record<number, number[]>;
}

export interface StandardEcuSpec {
  id: string;
  requestId: string;
  name: string;
  pad?: number;
  latencyMs?: number;
  /** Mode 01 PIDs with a value source; support bitmaps are generated from the keys. */
  pids: Record<number, ValueSource>;
  /** Override the generated support bitmaps (raw 4 bytes per page). */
  supportOverride?: Record<number, number[]>;
  dtcs?: DtcSet;
  /** Freeze frame 00; null = none stored (0202 answers 0000). */
  freeze?: FreezeFrame | null;
  /** Service 02 support bitmap pages (raw), answered even without a stored frame. */
  freezeSupport?: Record<number, number[]>;
  /** Service 06: MID -> concatenated 9-byte records; support pages generated. */
  mode06?: Record<number, number[]>;
  mode06Support?: Record<number, number[]>;
  /** Service 09: PID -> payload after "49 PID" (CAN format, count byte included). */
  mode09?: Record<number, number[]>;
  mode09Support?: number[];
  /** Service 08 supported test bitmap (0800); null = silent. */
  mode08?: number[] | null;
  /** Largest number of PIDs this ECU answers in one service 01 request. */
  maxMultiPid?: number;
}

export function encodeDtc(code: string): [number, number] {
  const sys = 'PCBU'.indexOf(code[0]!);
  const d1 = parseInt(code[1]!, 16);
  const rest = parseInt(code.slice(2), 16);
  return [(sys << 6) | (d1 << 4) | (rest >> 8), rest & 0xff];
}

function bitmapFor(pids: number[], base: number, nextPageAvailable: boolean): number[] {
  let v = 0n;
  for (const p of pids) if (p > base && p <= base + 0x20) v |= 1n << BigInt(32 - (p - base));
  if (nextPageAvailable) v |= 1n;
  return [Number((v >> 24n) & 0xffn), Number((v >> 16n) & 0xffn), Number((v >> 8n) & 0xffn), Number(v & 0xffn)];
}

/** Support bitmaps for the pages 00, 20, 40 ... that the PID set needs. */
export function supportPages(pids: number[]): Record<number, number[]> {
  const real = pids.filter((p) => p % 0x20 !== 0);
  const top = Math.max(0, ...real);
  const pages: Record<number, number[]> = { 0: [0, 0, 0, 0] };
  for (let base = 0; base <= 0xe0 && base < top; base += 0x20) {
    // the last bit of a page says "the next page exists"
    pages[base] = bitmapFor(real, base, top > base + 0x20);
  }
  return pages;
}

export class StandardEcu implements EcuModel {
  readonly id: string;
  readonly requestId: string;
  readonly name: string;
  readonly pad: number;
  readonly latencyMs: number;
  private spec: StandardEcuSpec;
  private support: Record<number, number[]>;
  private dtcs: DtcSet;
  private freeze: FreezeFrame | null;
  private mode06: Record<number, number[]>;
  private mode06Support: Record<number, number[]>;
  readonly maxMultiPid: number;
  cleared = 0;

  constructor(spec: StandardEcuSpec) {
    this.spec = spec;
    this.id = spec.id;
    this.requestId = spec.requestId;
    this.name = spec.name;
    this.pad = spec.pad ?? 0x00;
    this.latencyMs = spec.latencyMs ?? 12;
    this.support = spec.supportOverride ?? supportPages(Object.keys(spec.pids).map(Number));
    this.dtcs = spec.dtcs ? { stored: [...spec.dtcs.stored], pending: [...spec.dtcs.pending], permanent: spec.dtcs.permanent ? [...spec.dtcs.permanent] : null } : { stored: [], pending: [], permanent: null };
    this.freeze = spec.freeze ?? null;
    this.mode06 = { ...(spec.mode06 ?? {}) };
    this.mode06Support = spec.mode06Support ?? supportPages(Object.keys(this.mode06).map(Number));
    this.maxMultiPid = spec.maxMultiPid ?? 6;
  }

  supports(pid: number): boolean {
    if (pid % 0x20 === 0) return this.support[pid] !== undefined;
    return this.spec.pids[pid] !== undefined;
  }

  private pidData(pid: number, t: number): number[] | null {
    if (pid % 0x20 === 0) return this.support[pid] ?? null;
    const src = this.spec.pids[pid];
    return src ? src(t) : null;
  }

  handle(req: number[], t: number, physical: boolean): number[] | null {
    const svc = req[0]!;
    const neg = (nrc: number) => (physical ? [0x7f, svc, nrc] : null);
    switch (svc) {
      case 0x01: {
        const pids = req.slice(1);
        if (pids.length === 0 || pids.length > 6) return neg(0x13);
        if (pids.length > this.maxMultiPid) return neg(0x13);
        const out = [0x41];
        for (const p of pids) {
          const d = this.pidData(p, t);
          if (d) out.push(p, ...d);
        }
        return out.length > 1 ? out : neg(0x31);
      }
      case 0x02: {
        const pid = req[1];
        const frame = req[2] ?? 0;
        if (pid === undefined || frame !== 0) return neg(0x31);
        if (pid % 0x20 === 0) {
          const s = this.spec.freezeSupport?.[pid];
          return s ? [0x42, pid, frame, ...s] : neg(0x31);
        }
        if (pid === 0x02) {
          const [hi, lo] = this.freeze ? encodeDtc(this.freeze.dtc) : [0, 0];
          return [0x42, 0x02, frame, hi, lo];
        }
        const v = this.freeze?.values[pid];
        return v ? [0x42, pid, frame, ...v] : null;
      }
      case 0x03:
      case 0x07:
      case 0x0a: {
        const list = svc === 0x03 ? this.dtcs.stored : svc === 0x07 ? this.dtcs.pending : this.dtcs.permanent;
        if (list === null) return null;
        return [svc + 0x40, list.length, ...list.flatMap(encodeDtc)];
      }
      case 0x04:
        this.dtcs.stored = [];
        this.dtcs.pending = [];
        this.freeze = null;
        this.mode06 = {};
        this.cleared++;
        return [0x44];
      case 0x06: {
        const mid = req[1];
        if (mid === undefined) return neg(0x13);
        if (mid % 0x20 === 0) {
          const s = this.mode06Support[mid];
          return s ? [0x46, mid, ...s] : neg(0x31);
        }
        const r = this.mode06[mid];
        return r ? [0x46, ...r] : neg(0x31);
      }
      case 0x08: {
        if (req[1] !== 0x00 || !this.spec.mode08) return neg(0x31);
        return [0x48, 0x00, ...this.spec.mode08];
      }
      case 0x09: {
        const pid = req[1];
        if (pid === undefined) return neg(0x13);
        if (pid === 0x00) return this.spec.mode09Support ? [0x49, 0x00, ...this.spec.mode09Support] : neg(0x31);
        const v = this.spec.mode09?.[pid];
        return v ? [0x49, pid, ...v] : neg(0x31);
      }
      default:
        return physical ? [0x7f, svc, 0x11] : null;
    }
  }
}
