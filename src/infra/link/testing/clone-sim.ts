import type { Transport, VirtualClock } from '@obdcraft/obd-core';
import { answerReadDtc, type UdsFault } from './health-car.ts';

/**
 * Deterministic, seeded simulator of the live clone ELM327 v2.1 (BLE) in front of the Kushaq's VAG MQB modules.
 *
 * Every rule and number below comes from the 2026-10-25…11-01 live traces (live adapter forensics,
 * fault-model.md). The adapter silently drops a request before it reaches the module — about 20 % of the time
 * when sent at once after a reply, about 9 % after an ATSP0 re-search, about 95 % after idle time or after other
 * AT commands without a re-search — and a dropped request has no effect on the module at all. Nothing is ever
 * printed after a prompt. The modules keep a 5 s S3, a seed that only changes once a key arrives, and answer a
 * data write with `7F 2E 78` whose final answer is never heard.
 *
 * It is a `Transport`, so the real engine → ELM session → ISO-TP → writer stack runs against it unmodified on a
 * `VirtualClock`. Same seed and model ⇒ byte-identical wire transcript ({@link CloneElmSim.transcriptHash}).
 *
 * Besides the wire, it keeps a ground-truth log of what the modules themselves experienced ({@link TruthEvent});
 * tests judge the writer by that, never by what the writer believes.
 */

// ---------------------------------------------------------------------------------------------------------------
// Fault model
// ---------------------------------------------------------------------------------------------------------------

/** M = measured on the car, I = inferred, U = unmeasured (sweep it). */
export type Evidence = 'M' | 'I' | 'U';
export type Range = readonly [number, number];

export interface FaultModel {
  /** Adapter listen window after transmit, whatever ATST says. */
  windowMs: number;
  /** Host idle since the last prompt beyond which a locked send counts as stale. */
  staleIdleMs: number;
  /** Drop chance of a stale send (after idle, or after AT commands with no search pending). */
  pStale: number;
  /** Drop chance of a locked send made at once after a reply. */
  pLocked: number;
  /** Locked drop chance by the previous reply from the same module and the request (prefix hex, no spaces). */
  transitions: readonly { after: string; request: string; p: number }[];
  /** Search drop chance when the previous search request on this module was answered / was silent. */
  pSearchOk: number;
  pSearchAfterSilent: number;
  /** A silent search ends in the doubled `UNABLE TO CONNECT` (at {@link unableMs}) instead of NO DATA. */
  pSearchUnable: number;
  /** Pre-transmit delay of a search: the fast class with this chance (lower after a silent request). */
  pFastSearch: number;
  pFastSearchAfterSilent: number;
  fastSearchMs: Range;
  slowSearchMs: Range;
  /** The first consecutive frame after the module's flow control. */
  pFirstCf: number;
  /** Later consecutive frames of a host transfer (none measured: they expect no reply). */
  pMidCf: number;
  /** The host's own flow control granting the next block of a multi-frame reply (never run on the car). */
  pRxFc: number;
  /** The last consecutive frame of a reply of at most `rxCfCap` CFs is lost. */
  pLastRxCfLoss: number;
  /** Consecutive frames the adapter forwards per command. */
  rxCfCap: number;
  /** Prompt time (from transmit) when a reply needed more CFs than the cap. */
  truncatedPromptMs: Range;
  /** Time of the doubled `UNABLE TO CONNECT` after a search nobody answers. */
  unableMs: Range;
  /** Extra adapter delay before the NO DATA of a send dropped after idle (host sees 350–585 ms). */
  idleDropExtraMs: Range;
  /** AT command round trip, bimodal on 30 ms BLE connection events: short class chance and both ranges. */
  pAtShort: number;
  atShortMs: Range;
  atLongMs: Range;
  /** Host → adapter: one GATT write, then the BLE uplink to the adapter. */
  writeMs: Range;
  upMs: Range;
  /** Adapter → host notification delay. */
  downMs: Range;
  /** Module latency for 10/27/2E/3E/31/11 and flow control, for 22, and the slow tail. */
  ecuFastMs: Range;
  ecuReadMs: Range;
  pEcuTail: number;
  ecuTailMs: Range;
  /** S3: the extended session lapses this long after the last request the module received. */
  s3Ms: number;
  /** Time from a delivered data write (answered 78) until the value is stored. */
  commitMs: Range;
  /** ISO 15765-2 N_Bs / N_Cr: a module waits this long for the next FC / CF. */
  nBsMs: number;
  /** The module processed the request but its reply never reaches the host (robustness only; never seen). */
  pRxLoss: number;
  /** The cluster issues a new seed on every 27 03. */
  cluSeedPerRequest: boolean;
  /** A delivered `2E 05 74` on the B7 gets no reply and is not stored. */
  b7_0574_silent: boolean;
  /** HVAC data writes need security access. */
  hvacNeedsSecurity: boolean;
  /**
   * The owner's OBDBLE clone: a raw (ATCAF0) frame handed over as all 8 bytes leaves with its 8th byte replaced by
   * the first byte of the adapter's flow-control data (ATFCSD, 0x30 on the coding channel) — bytes 1–7 intact. The
   * value matches the stored 0x30 seen live; the flow-control source is a hypothesis (the `fc-alt` mode tests it). A
   * frame of 7 bytes or fewer is padded with 00 and arrives intact. Off by default: the measured runs never had it.
   */
  corruptFullFrames: boolean;
}

export const DEFAULT_FAULT_MODEL: Readonly<FaultModel> = Object.freeze<FaultModel>({
  windowMs: 205,
  staleIdleMs: 250,
  pStale: 0.95,
  pLocked: 0.2,
  transitions: Object.freeze([
    { after: '5003', request: '2703', p: 0 }, //   0/22
    { after: '6704', request: '2E', p: 0.41 }, //  7/17
    { after: '7E00', request: '1003', p: 0.36 }, // 8/22
    { after: '5003', request: '22', p: 0.26 }, //  6/23
    { after: '6703', request: '2704', p: 0.18 }, // 4/22
    { after: '6E', request: '2E', p: 0.17 }, //    4/23
  ]),
  pSearchOk: 0.06,
  pSearchAfterSilent: 0.36,
  pSearchUnable: 0.25,
  pFastSearch: 0.38,
  pFastSearchAfterSilent: 0.03,
  fastSearchMs: [100, 130],
  slowSearchMs: [210, 250],
  pFirstCf: 0.17,
  pMidCf: 0,
  pRxFc: 0.2,
  pLastRxCfLoss: 0.006,
  rxCfCap: 4,
  truncatedPromptMs: [900, 1000],
  unableMs: [4350, 4580],
  idleDropExtraMs: [100, 300],
  pAtShort: 0.45,
  atShortMs: [55, 65],
  atLongMs: [85, 97],
  writeMs: [1, 4],
  upMs: [5, 20],
  downMs: [15, 45],
  ecuFastMs: [60, 100],
  ecuReadMs: [95, 130],
  pEcuTail: 0.04,
  ecuTailMs: [150, 200],
  s3Ms: 5000,
  commitMs: [200, 1500],
  nBsMs: 1000,
  pRxLoss: 0,
  cluSeedPerRequest: false,
  b7_0574_silent: true,
  hvacNeedsSecurity: false,
  corruptFullFrames: false,
});

/** Where each default comes from (BRIEF.md §2.2–2.4, fault-model.md). */
export const FAULT_MODEL_EVIDENCE: Readonly<Record<keyof FaultModel, Evidence>> = Object.freeze({
  windowMs: 'M',
  staleIdleMs: 'U', // shortest measured idle drop was 500 ms; sweep 50–450
  pStale: 'M',
  pLocked: 'M',
  transitions: 'M',
  pSearchOk: 'M',
  pSearchAfterSilent: 'M',
  pSearchUnable: 'I', // ~23 fitted-module UNABLEs vs 73 NO DATA among 876 searches (chains.md §1)
  pFastSearch: 'M',
  pFastSearchAfterSilent: 'M',
  fastSearchMs: 'M',
  slowSearchMs: 'M',
  pFirstCf: 'M',
  pMidCf: 'U',
  pRxFc: 'I', // treated as any locked send; the BS=4 path never ran on the car
  pLastRxCfLoss: 'M',
  rxCfCap: 'M',
  truncatedPromptMs: 'M',
  unableMs: 'M',
  idleDropExtraMs: 'M',
  pAtShort: 'M',
  atShortMs: 'M',
  atLongMs: 'M',
  writeMs: 'M',
  upMs: 'I',
  downMs: 'I',
  ecuFastMs: 'I',
  ecuReadMs: 'I',
  pEcuTail: 'M',
  ecuTailMs: 'M',
  s3Ms: 'M',
  commitMs: 'U',
  nBsMs: 'I',
  pRxLoss: 'U',
  cluSeedPerRequest: 'I',
  b7_0574_silent: 'M',
  hvacNeedsSecurity: 'U',
  corruptFullFrames: 'I', // stored 0x30 / 0xA0 in byte 8 live; the buffer source is inferred
});

// ---------------------------------------------------------------------------------------------------------------
// Randomness: one PRNG per run, every draw through `draw(tag)`
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32. `Math.random` is never used by the simulator. */
export class SimRng {
  private state: number;
  /** Draws made, by tag (diagnostics; the order of draws is fixed by the code path). */
  readonly counts = new Map<string, number>();

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  draw(tag: string): number {
    this.counts.set(tag, (this.counts.get(tag) ?? 0) + 1);
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  chance(tag: string, p: number): boolean {
    // Always draws, so a changed probability never shifts the rest of the run's draws.
    const x = this.draw(tag);
    return x < p;
  }

  uniform(tag: string, [lo, hi]: Range): number {
    return lo + (hi - lo) * this.draw(tag);
  }

  int32(tag: string): number {
    return Math.floor(this.draw(tag) * 4294967296) >>> 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------------------------------------------

export type DropReason = 'search' | 'stale-idle' | 'stale-at' | 'locked' | 'cf' | 'rx-fc';
export type NrcCause =
  | 'default-session'
  | 'security'
  | 'not-hosted'
  | 'length'
  | 'sequence'
  | 'invalid-key'
  | 'lockout'
  | 'not-supported';

export type TruthEvent =
  /** A complete request reached the module's application layer. */
  | { t: number; type: 'ecuRx'; ecu: string; bytes: string }
  /** A frame the adapter never put through to the module. */
  | { t: number; type: 'dropped'; ecu: string; bytes: string; reason: DropReason }
  | {
      t: number;
      type: 'session';
      ecu: string;
      from: number;
      to: number;
      why: 'request' | 's3-lapse' | 'reset';
    }
  | { t: number; type: 'seed'; ecu: string; seed: number }
  /** `duplicate`: a key delivered for a seed whose key had already been delivered. */
  | { t: number; type: 'key'; ecu: string; seed: number; ok: boolean; duplicate: boolean }
  | { t: number; type: 'nrc'; ecu: string; service: number; did?: string; nrc: number; cause: NrcCause }
  | { t: number; type: 'pending'; ecu: string; did: string }
  /** The module's memory changed. `redundant`: it already held these bytes when the write arrived. */
  | { t: number; type: 'stored'; ecu: string; did: string; bytes: string; redundant: boolean }
  | { t: number; type: 'commitDone'; ecu: string; did: string }
  /** A data write was delivered (whatever its answer); `held` = what the module stored at that moment. */
  | { t: number; type: 'writeDelivered'; ecu: string; did: string; bytes: string; held: string | undefined }
  /** The module answered but the host never saw it. */
  | { t: number; type: 'replyLost'; ecu: string; bytes: string; reason: 'after-prompt' | 'rx-loss' | 'late' }
  /** A data write the B7 quirk swallowed. */
  | { t: number; type: 'quirk'; ecu: string; did: string; what: string };

/** Request discipline (BRIEF §5 criterion 6), checked on every request. */
export interface DisciplineCounts {
  /** A top-level request sent locked more than 20 ms after the last prompt. */
  lockedAfterIdle: number;
  /** A top-level request sent after a non-ATSP0 AT command with no search pending. */
  afterAtNoSearch: number;
  atR0: number;
  bareCr: number;
}

/** One frame the host put on the wire (adapter-side view). */
export interface WireTx {
  t: number;
  /** Module request id the adapter was addressing (`ATSH`). */
  header: string;
  bytes: number[];
  /** SF or FF (or any CAF1 request), as opposed to a CF or the host's own flow control. */
  topLevel: boolean;
  path: 'search' | 'stale' | 'locked' | 'transfer';
  delivered: boolean;
}

/** A complete response PDU the host was shown (reassembled from what the adapter printed). */
export interface HostSaw {
  t: number;
  ecu: string;
  pdu: number[];
}

// ---------------------------------------------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------------------------------------------

export interface EcuSpec {
  /** Short label for logs ("BCM"). */
  name: string;
  /** Physical request id (`70E`) and response id (`778`). */
  request: string;
  response: string;
  /** Padding byte of the module's frames. */
  pad?: number;
  /** Security logins it accepts (key = seed + login mod 2^32). Empty: data writes need no security. */
  logins?: readonly number[];
  /** Hosted DIDs and their bytes (hex). Anything else answers 7F 22 31 / 7F 2E 31. */
  dids?: Record<string, string>;
  /** DIDs whose read answers 78 and never a final answer (BCM 0560). */
  pendingReads?: readonly string[];
  /** DIDs whose delivered write gets no answer and is not stored (B7 0574). */
  silentWrites?: readonly string[];
  /** Data writes need security even with logins configured elsewhere (HVAC switch). */
  writesNeedSecurity?: boolean;
  /** A new seed on every 27 03 (cluster flag). */
  seedPerRequest?: boolean;
  /** Answers functional 7DF service 01 (engine 7E8, transmission 7E9). */
  obd?: boolean;
  /**
   * Generic OBD-II answers (services 01-0A, functional or physical) instead of the built-in parked engine: the
   * health snapshot's rehearsal car. Absent: only 01 00 / 0C / 0D, as before.
   */
  obdAnswer?: (req: readonly number[], t: number, physical: boolean) => number[] | null;
  /** The fault memory 19 ReadDTCInformation answers from (see health-car.ts). Absent: 19 is refused (7F 19 11). */
  faults?: readonly UdsFault[];
  /**
   * `19 02` answers `7F 19 78` at once and the fault list this long after (brakes 713 and airbags 715 live
   * 2026-11-09). The late answer is heard only when it reaches the bus inside a later send's response window to
   * this module (the clone prints nothing after its prompt); otherwise it is lost.
   */
  slowDtcListMs?: number;
  /**
   * The clone's byte-8 stray as the module receives it (live 2026-11-09): every full CAN frame of a delivered data
   * write carries this byte in its 8th position (a 7-byte single frame's last data byte, a first frame's 6th payload
   * byte, each full consecutive frame's last), and the module stores what it received. Absent: writes arrive whole.
   */
  strayByte?: number;
}

/** DIDs that are written as cosmetic markers: they never need security. */
const MARKER_DIDS = new Set(['F199', 'F198', 'F1A0', 'F1A1']);
/** DIDs every module refuses to READ (`22 F199` → 7F 22 31 everywhere, live). */
const UNREADABLE = new Set(['F199']);

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hexOf = (bytes: readonly number[]) => bytes.map(hx).join('');
const bytesOf = (hex: string) => (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));

interface Emission {
  /** Absolute adapter time the frame is on the bus. */
  at: number;
  data: number[];
}

/** Session ids: 1 default, 3 extended, 0x40 VAG end-of-line. */
const DEFAULT_SESSION = 1;

export class SimEcu {
  readonly spec: EcuSpec;
  readonly pad: number;
  /** Current memory (hex by DID). */
  readonly dids = new Map<string, string>();
  session = DEFAULT_SESSION;
  unlocked = false;
  private seed = 0;
  /** A 27 03 was answered since the last delivered key: the next key is a first delivery. */
  private seedOpen = false;
  private wrongKeys = 0;
  private lastRxAt = Number.NEGATIVE_INFINITY;
  /** Reassembly of a host multi-frame request. */
  private rx: { length: number; bytes: number[]; next: number; at: number; inBlock: number } | null = null;
  /** Remaining CFs of a multi-frame answer, waiting for the host's flow control. */
  private tx: { frames: number[][]; waitingSince: number; pdu: number[] } | null = null;
  /** Final answers sent on the module's own time after a 78 ({@link EcuSpec.slowDtcListMs}). */
  private late: { at: number; frames: number[][]; pdu: number[] }[] = [];
  private readonly sim: CloneElmSim;

  constructor(sim: CloneElmSim, spec: EcuSpec) {
    this.sim = sim;
    this.spec = spec;
    this.pad = spec.pad ?? 0xaa;
    for (const [did, value] of Object.entries(spec.dids ?? {}))
      this.dids.set(did.toUpperCase(), value.toUpperCase());
  }

  private get m(): FaultModel {
    return this.sim.model;
  }

  private truth(e: DistributiveOmit<TruthEvent, 't' | 'ecu'>, t: number): void {
    this.sim.truth.push({ ...e, t, ecu: this.spec.request } as TruthEvent);
  }

  private frame(bytes: number[]): number[] {
    const f = [...bytes];
    while (f.length < 8) f.push(this.pad);
    return f;
  }

  /** The PDU as single or first frame plus the CFs that follow it. */
  private segment(pdu: number[]): number[][] {
    if (pdu.length <= 7) return [this.frame([pdu.length, ...pdu])];
    const frames = [this.frame([0x10 | (pdu.length >> 8), pdu.length & 255, ...pdu.slice(0, 6)])];
    for (let i = 6, seq = 1; i < pdu.length; i += 7, seq++)
      frames.push(this.frame([0x20 | (seq & 15), ...pdu.slice(i, i + 7)]));
    return frames;
  }

  private latency(service: number): number {
    if (this.sim.rng.chance('ecu.tail', this.m.pEcuTail))
      return this.sim.rng.uniform('ecu.tailMs', this.m.ecuTailMs);
    return this.sim.rng.uniform('ecu.latency', service === 0x22 ? this.m.ecuReadMs : this.m.ecuFastMs);
  }

  /**
   * The late answers on the bus in [from, to] — the adapter is listening then. Those that went out before `from`
   * fell after a prompt and are lost.
   */
  takeLate(from: number, to: number): Emission[] {
    const out: Emission[] = [];
    this.late = this.late.filter((l) => {
      if (l.at > to) return true;
      if (l.at < from) {
        this.truth({ type: 'replyLost', bytes: hexOf(l.frames[0] ?? []), reason: 'after-prompt' }, l.at);
        return false;
      }
      const [first = [], ...rest] = l.frames;
      this.tx = rest.length ? { frames: rest, waitingSince: l.at, pdu: l.pdu } : null;
      out.push({ at: l.at, data: first });
      return false;
    });
    return out;
  }

  /** S3: a lapse is applied when the next frame arrives. */
  private touch(t: number): void {
    if (this.session !== DEFAULT_SESSION && t - this.lastRxAt > this.m.s3Ms) {
      this.truth({ type: 'session', from: this.session, to: DEFAULT_SESSION, why: 's3-lapse' }, t);
      this.session = DEFAULT_SESSION;
      this.unlocked = false;
    }
    this.lastRxAt = t;
  }

  /** A frame from the host reached the module. Returns what it puts on the bus in answer. */
  receive(frame: readonly number[], t: number): Emission[] {
    this.touch(t);
    const kind = (frame[0] ?? 0) >> 4;
    if (kind === 0) {
      const len = (frame[0] ?? 0) & 15;
      if (len < 1 || len > 7) return [];
      this.rx = null;
      return this.request(frame.slice(1, 1 + len), t);
    }
    if (kind === 1) {
      const length = (((frame[0] ?? 0) & 15) << 8) | (frame[1] ?? 0);
      if (length <= 7) return [];
      this.rx = { length, bytes: frame.slice(2, 8), next: 1, at: t, inBlock: 0 };
      // The transport layer accepts a first frame in any session (8/8 live): flow control 30 0F 05.
      return [{ at: t + this.latency(0x2e), data: this.frame([0x30, 0x0f, 0x05]) }];
    }
    if (kind === 2) {
      const rx = this.rx;
      if (!rx || ((frame[0] ?? 0) & 15) !== (rx.next & 15) || t - rx.at > this.m.nBsMs) {
        this.rx = null; // ISO 15765-2: an unexpected CF is ignored; the transfer is abandoned
        return [];
      }
      rx.bytes.push(...frame.slice(1, 8));
      rx.next++;
      rx.at = t;
      if (rx.bytes.length >= rx.length) {
        this.rx = null;
        return this.request(rx.bytes.slice(0, rx.length), t);
      }
      if (++rx.inBlock === 15) {
        rx.inBlock = 0;
        return [{ at: t + this.latency(0x2e), data: this.frame([0x30, 0x0f, 0x05]) }];
      }
      return [];
    }
    if (kind === 3) return this.flowControl(frame, t);
    return [];
  }

  /**
   * Flow control for a multi-frame answer: from the adapter right after the FF (`ATFCSD`), or from the host
   * granting the next block. Block size 0 sends everything; otherwise that many CFs, then waits up to N_Bs.
   */
  flowControl(fc: readonly number[], t: number): Emission[] {
    const tx = this.tx;
    if (!tx || ((fc[0] ?? 0) & 15) !== 0) return [];
    if (t - tx.waitingSince > this.m.nBsMs) {
      this.tx = null;
      return [];
    }
    const block = fc[1] ?? 0;
    const st = Math.max(1, (fc[2] ?? 0) <= 0x7f ? (fc[2] ?? 0) : 1);
    const take = block === 0 ? tx.frames.length : Math.min(block, tx.frames.length);
    const out = tx.frames.splice(0, take).map((data, i) => ({ at: t + 1 + i * st, data }));
    if (tx.frames.length) tx.waitingSince = out.at(-1)?.at ?? t;
    else this.tx = null;
    return out;
  }

  private answer(pdu: number[], t: number, service: number): Emission[] {
    if (this.sim.rng.chance('ecu.rxLoss', this.m.pRxLoss)) {
      this.truth({ type: 'replyLost', bytes: hexOf(pdu), reason: 'rx-loss' }, t);
      return [];
    }
    const at = t + this.latency(service);
    const frames = this.segment(pdu);
    const first = frames.shift() ?? [];
    this.tx = frames.length ? { frames, waitingSince: at, pdu } : null;
    return [{ at, data: first }];
  }

  private nrc(service: number, code: number, cause: NrcCause, t: number, did?: string): Emission[] {
    this.truth({ type: 'nrc', service, nrc: code, cause, ...(did ? { did } : {}) }, t);
    return this.answer([0x7f, service, code], t, service);
  }

  private setSession(to: number, t: number, why: 'request' | 'reset'): void {
    if (to !== this.session) this.truth({ type: 'session', from: this.session, to, why }, t);
    this.session = to;
    this.unlocked = false; // any 10 xx (and a reset) relocks security
  }

  private needsSecurity(did: string): boolean {
    if (MARKER_DIDS.has(did)) return false;
    if (this.spec.writesNeedSecurity !== undefined) return this.spec.writesNeedSecurity;
    return (this.spec.logins?.length ?? 0) > 0;
  }

  private request(req: number[], t: number): Emission[] {
    this.truth({ type: 'ecuRx', bytes: hexOf(req) }, t);
    const [svc = 0, a = 0, b = 0] = req;
    if (this.spec.obdAnswer && svc >= 0x01 && svc <= 0x0a) {
      const pdu = this.spec.obdAnswer(req, t / 1000, true);
      return pdu ? this.answer(pdu, t, svc) : [];
    }
    const did = hx(a) + hx(b);
    switch (svc) {
      case 0x3e:
        // Positive response suppressed (3E 80): the module stays silent.
        if (a & 0x80) return [];
        return this.answer([0x7e, a & 0x7f], t, svc);
      case 0x10:
        if (a !== 0x01 && a !== 0x03 && a !== 0x40) return this.nrc(svc, 0x12, 'not-supported', t);
        this.setSession(a, t, 'request');
        return this.answer([0x50, a, 0x00, 0x32, 0x01, 0xf4], t, svc);
      case 0x11:
        this.setSession(DEFAULT_SESSION, t, 'reset');
        return this.answer([0x51, a], t, svc);
      case 0x22: {
        if (UNREADABLE.has(did)) return this.nrc(svc, 0x31, 'not-hosted', t, did);
        if (this.spec.pendingReads?.includes(did)) {
          this.truth({ type: 'pending', did }, t);
          return this.answer([0x7f, 0x22, 0x78], t, svc);
        }
        const value = this.dids.get(did);
        if (value === undefined) return this.nrc(svc, 0x31, 'not-hosted', t, did);
        return this.answer([0x62, a, b, ...bytesOf(value)], t, svc);
      }
      case 0x19:
        if (!this.spec.faults) return this.nrc(svc, 0x11, 'not-supported', t);
        if (this.spec.slowDtcListMs !== undefined && a === 0x02) {
          const pdu = answerReadDtc(req, this.spec.faults);
          const at = t + this.spec.slowDtcListMs;
          this.late.push({ at, frames: this.segment(pdu), pdu });
          return this.answer([0x7f, 0x19, 0x78], t, svc);
        }
        return this.answer(answerReadDtc(req, this.spec.faults), t, svc);
      case 0x27:
        return this.security(req, t);
      case 0x2e:
        return this.write(req, did, t);
      default:
        return this.nrc(svc, 0x11, 'not-supported', t);
    }
  }

  private security(req: number[], t: number): Emission[] {
    const sub = req[1] ?? 0;
    if (this.session === DEFAULT_SESSION) return this.nrc(0x27, 0x7f, 'default-session', t);
    if (sub === 0x03) {
      if (this.wrongKeys >= 3) return this.nrc(0x27, 0x37, 'lockout', t);
      // The seed holds until a key arrives (BCM, B7: 3/3 identical after a dropped key); the cluster may roll it.
      const roll = !this.seedOpen && this.seed === 0;
      if (roll || (this.spec.seedPerRequest ?? false)) this.newSeed();
      this.seedOpen = true;
      this.truth({ type: 'seed', seed: this.seed }, t);
      return this.answer([0x67, 0x03, ...[24, 16, 8, 0].map((s) => (this.seed >>> s) & 255)], t, 0x27);
    }
    if (sub === 0x04) {
      const key = req.slice(2, 6).reduce((v, x) => (v * 256 + x) >>> 0, 0);
      const seed = this.seed;
      const duplicate = !this.seedOpen;
      const ok = !duplicate && (this.spec.logins ?? []).some((login) => (seed + login) >>> 0 === key);
      this.truth({ type: 'key', seed, ok, duplicate }, t);
      if (duplicate) return this.nrc(0x27, 0x24, 'sequence', t);
      // Any delivered key consumes the seed: the next 27 03 gets a new one (15/15 live).
      this.seedOpen = false;
      this.newSeed();
      if (!ok) {
        this.wrongKeys++;
        return this.nrc(0x27, this.wrongKeys >= 3 ? 0x36 : 0x35, 'invalid-key', t);
      }
      this.wrongKeys = 0;
      this.unlocked = true;
      return this.answer([0x67, 0x04], t, 0x27);
    }
    return this.nrc(0x27, 0x12, 'not-supported', t);
  }

  private newSeed(): void {
    let s = 0;
    while (s === 0) s = this.sim.rng.int32('ecu.seed');
    this.seed = s;
  }

  private write(req: number[], did: string, t: number): Emission[] {
    const data = req.slice(3);
    if (this.spec.strayByte !== undefined) {
      const stray = req.length === 7 ? [6] : [];
      if (req.length > 7) for (let i = 5; i < req.length; i += 7) stray.push(i);
      for (const i of stray) data[i - 3] = this.spec.strayByte;
    }
    const marker = MARKER_DIDS.has(did);
    // The lapse signature on these modules: 7F 2E 31 in the default session (12/12 live).
    if (this.session === DEFAULT_SESSION) return this.nrc(0x2e, 0x31, 'default-session', t, did);
    if (marker) {
      this.store(did, hexOf(data), t);
      return this.answer([0x6e, req[1] ?? 0, req[2] ?? 0], t, 0x2e);
    }
    const held = this.dids.get(did);
    if (held === undefined) return this.nrc(0x2e, 0x31, 'not-hosted', t, did);
    if (this.needsSecurity(did) && !this.unlocked) return this.nrc(0x2e, 0x33, 'security', t, did);
    if (data.length * 2 !== held.length) return this.nrc(0x2e, 0x13, 'length', t, did);
    this.sim.truth.push({ t, type: 'writeDelivered', ecu: this.spec.request, did, bytes: hexOf(data), held });
    if (this.spec.silentWrites?.includes(did)) {
      this.truth({ type: 'quirk', did, what: 'silent write: no answer, not stored' }, t);
      return [];
    }
    // 7F 2E 78, the value lands after the commit, and the final 6E comes after the adapter has prompted.
    this.truth({ type: 'pending', did }, t);
    const commit = this.sim.rng.uniform('ecu.commitMs', this.m.commitMs);
    const bytes = hexOf(data);
    this.sim.later(t + commit, () => {
      this.store(did, bytes, this.sim.now());
      this.truth({ type: 'commitDone', did }, this.sim.now());
      this.sim.truth.push({
        t: this.sim.now(),
        type: 'replyLost',
        ecu: this.spec.request,
        bytes: `6E${did}`,
        reason: 'after-prompt',
      });
    });
    return this.answer([0x7f, 0x2e, 0x78], t, 0x2e);
  }

  private store(did: string, bytes: string, t: number): void {
    const redundant = this.dids.get(did) === bytes;
    this.dids.set(did, bytes);
    this.truth({ type: 'stored', did, bytes, redundant }, t);
  }

  /** Functional OBD-II service 01 (engine and transmission): parked, engine off. */
  obd(req: readonly number[], t: number): Emission[] {
    if (this.spec.obdAnswer) {
      this.touch(t);
      const pdu = this.spec.obdAnswer(req, t / 1000, false);
      return pdu ? this.answer(pdu, t, req[0] ?? 0) : [];
    }
    if (!this.spec.obd || req[0] !== 0x01) return [];
    this.touch(t);
    const pid = req[1] ?? 0;
    const data: Record<number, number[]> = { 0: [0xbe, 0x3f, 0xa8, 0x13], 12: [0, 0], 13: [0] };
    const value = data[pid];
    return value ? this.answer([0x41, pid, ...value], t, 0x01) : [];
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------------------------

export interface CloneSimOptions {
  clock: VirtualClock;
  seed: number;
  model?: Partial<FaultModel>;
  ecus: readonly EcuSpec[];
  /** Battery voltage ATRV reports. */
  voltage?: number;
}

/** Host-visible wire log entry (what a BLE capture would show). */
export interface WireEntry {
  t: number;
  dir: 'tx' | 'rx';
  text: string;
}

export class CloneElmSim implements Transport {
  readonly kind = 'emulator' as const;
  readonly name = 'Clone ELM327 simulator';
  readonly id = 'clone-sim';
  readonly maxWrite = 20;
  isOpen = false;

  readonly model: FaultModel;
  readonly rng: SimRng;
  readonly ecus: SimEcu[];
  readonly truth: TruthEvent[] = [];
  readonly wire: WireEntry[] = [];
  readonly txLog: WireTx[] = [];
  readonly hostSaw: HostSaw[] = [];
  readonly discipline: DisciplineCounts = { lockedAfterIdle: 0, afterAtNoSearch: 0, atR0: 0, bareCr: 0 };

  private readonly clock: VirtualClock;
  private readonly voltage: number;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<(r: string) => void>();
  private inbuf = '';
  private lastCmd = '';
  /** Pending output of the command in progress; cancelled by an interrupting character. */
  private busy: { cancelled: boolean } | null = null;

  // ELM state
  private echo = true;
  private headers = false;
  private spaces = true;
  private caf = true;
  private header = '7DF';
  private cra: string | null = null;
  private fcData: number[] = [0x30, 0x00, 0x00];
  private fcMode = 0;
  // clone state machine (BRIEF §2.3)
  private searchPending = true;
  private stale: 'idle' | 'at' | null = null;
  /** AT commands since the last request (discipline check). */
  private atSinceRequest = false;
  /** When the host received the last prompt (idle and discipline are host-side measures). */
  private lastPromptAt = 0;
  /** Per module: the previous search request was silent; the previous request of any kind was silent. */
  private searchSilent = new Map<string, boolean>();
  private lastSilent = new Map<string, boolean>();
  /** Per module: the last reply PDU the host was shown (for the transition overrides). */
  private lastReply = new Map<string, number[]>();
  /** Per module: the host's frames since its last FC (for the FC → CF override). */
  private sinceFc = new Map<string, number>();
  /** Per module: partial multi-frame answer as the host has seen it so far. */
  private shown = new Map<string, { length: number; bytes: number[] }>();

  constructor(opts: CloneSimOptions) {
    this.clock = opts.clock;
    this.model = { ...DEFAULT_FAULT_MODEL, ...opts.model };
    this.rng = new SimRng(opts.seed);
    this.voltage = opts.voltage ?? 12.6;
    this.ecus = opts.ecus.map((spec) => new SimEcu(this, spec));
  }

  now(): number {
    return this.clock.now();
  }

  /** Runs `fire` at absolute virtual time `at` (module-side timers such as a commit). */
  later(at: number, fire: () => void): void {
    this.clock.schedule(Math.max(0, at - this.clock.now()), fire);
  }

  ecu(request: string): SimEcu | undefined {
    return this.ecus.find((e) => e.spec.request === request.toUpperCase());
  }

  /** What the module holds now (ground truth). */
  stored(request: string, did: string): string | undefined {
    return this.ecu(request)?.dids.get(did.toUpperCase());
  }

  /** FNV-1a over the host-visible transcript: identical for identical seed and model. */
  transcriptHash(): string {
    let h = 0x811c9dc5;
    for (const e of this.wire) {
      for (const ch of `${e.t.toFixed(3)}${e.dir}${e.text}\n`) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h.toString(16).padStart(8, '0');
  }

  // ---- Transport ----

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.busy) this.busy.cancelled = true;
    for (const cb of this.closeCbs) cb('closed');
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.isOpen) throw new Error('simulator closed');
    const text = String.fromCharCode(...data);
    await this.clock.sleep(this.rng.uniform('ble.write', this.model.writeMs));
    for (const ch of text) this.onChar(ch);
  }

  // ---- adapter ----

  private onChar(ch: string): void {
    if (this.busy) {
      // Any character interrupts a busy ELM327; it is consumed as the stop signal.
      this.busy.cancelled = true;
      this.busy = null;
      this.inbuf = '';
      this.emitAt(this.now() + 5, 'STOPPED\r\r>', true);
      return;
    }
    if (ch === '\n') return;
    if (ch !== '\r') {
      this.inbuf += ch;
      return;
    }
    const raw = this.inbuf;
    this.inbuf = '';
    if (raw.trim() === '') {
      // A bare CR repeats the last command: the writer must never send one.
      this.discipline.bareCr++;
      this.execute(this.lastCmd);
      return;
    }
    this.lastCmd = raw;
    this.execute(raw);
  }

  /** Text reaches the host one downlink delay after the adapter prints it. `prompt` ends the command. */
  private emitAt(adapterAt: number, text: string, prompt: boolean, handle = this.busy): void {
    const down = this.rng.uniform('ble.down', this.model.downMs);
    this.later(adapterAt + down, () => {
      if (handle?.cancelled || !this.isOpen) return;
      if (prompt) this.lastPromptAt = this.now();
      if (prompt && this.busy === handle) this.busy = null;
      this.wire.push({ t: this.now(), dir: 'rx', text });
      const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
      for (const cb of this.dataCbs) cb(bytes);
    });
  }

  private reply(at: number, raw: string, body: string): void {
    const echo = this.echo ? `${raw}\r` : '';
    this.emitAt(at, `${echo}${body}\r\r>`, true);
  }

  private execute(raw: string): void {
    const t = this.now();
    this.wire.push({ t, dir: 'tx', text: raw });
    this.busy = { cancelled: false };
    const cmd = raw.replace(/\s+/g, '').toUpperCase();
    if (cmd.startsWith('AT') || cmd === 'STI' || cmd === 'STDI') {
      this.executeAt(raw, cmd.startsWith('AT') ? cmd.slice(2) : cmd, t);
      return;
    }
    if (!/^[0-9A-F]+$/.test(cmd) || cmd.length < 2) {
      this.reply(t + this.atRtt(), raw, '?');
      return;
    }
    this.executeRequest(raw, cmd, t);
  }

  private atRtt(): number {
    const short = this.rng.chance('ble.atClass', this.model.pAtShort);
    return this.rng.uniform('ble.atRtt', short ? this.model.atShortMs : this.model.atLongMs);
  }

  private executeAt(raw: string, a: string, t: number): void {
    // Every AT command but ATSP0 makes the next locked send stale; a pending search survives them (21/21).
    if (a !== 'SP0' && !this.searchPending) this.stale = 'at';
    if (a !== 'SP0') this.atSinceRequest = true;
    if (a === 'Z' || a === 'WS') {
      this.echo = true;
      this.headers = false;
      this.spaces = true;
      this.caf = true;
      this.cra = null;
      this.header = '7DF';
      this.fcData = [0x30, 0x00, 0x00];
      this.fcMode = 0;
      this.searchPending = true;
      this.emitAt(t + (a === 'Z' ? 700 : 300), `${raw}\r\r\rELM327 v2.1\r\r>`, true);
      return;
    }
    this.reply(t + this.atRtt(), raw, this.atAnswer(a));
  }

  /** Applies one AT command (other than a reset) and returns what the adapter prints. */
  private atAnswer(a: string): string {
    const fixed: Record<string, string> = {
      I: 'ELM327 v2.1',
      '@1': 'OBDII to RS232 Interpreter',
      '@2': '?',
      MA: '?', // no monitor mode on the clone
      STI: '?',
      STDI: '?',
      RV: `${this.voltage.toFixed(1)}V`,
      DPN: 'A6',
      DP: 'AUTO, ISO 15765-4 (CAN 11/500)',
    };
    const answer = fixed[a];
    if (answer !== undefined) return answer;
    const flag = /^(E|S|H|R|CAF)([01])$/.exec(a);
    if (flag) {
      const on = flag[2] === '1';
      if (flag[1] === 'E') this.echo = on;
      if (flag[1] === 'S') this.spaces = on;
      if (flag[1] === 'H') this.headers = on;
      if (flag[1] === 'CAF') this.caf = on;
      // ATR0 is ignored by the clone: it still listens and prints NO DATA (3/3).
      if (flag[1] === 'R' && !on) this.discipline.atR0++;
      return 'OK';
    }
    if (/^SPA?[0-9A-C]$/.test(a)) {
      if (a === 'SP0') this.searchPending = true;
      return 'OK';
    }
    const arg = /^(SH|CRA|FCSD|FCSM)([0-9A-F]*)$/.exec(a);
    if (arg) {
      const [, name, value = ''] = arg;
      if (name === 'SH' && value.length === 3) this.header = value;
      else if (name === 'CRA' && (value.length === 3 || value === '')) this.cra = value || null;
      else if (name === 'FCSD' && value.length >= 2 && value.length % 2 === 0) this.fcData = bytesOf(value);
      else if (name === 'FCSM' && /^[0-2]$/.test(value)) this.fcMode = Number(value);
      else return '?';
      return 'OK';
    }
    // ATST/ATAT answer OK and change nothing (the window is always ~205 ms); the rest are plain settings.
    if (/^(ST[0-9A-F]{2}|AT[0-2]|L[01]|M[01]|D[01]?|CFC[01]|FCSH[0-9A-F]{3}|PC|CS|AR|AL|NL)$/.test(a))
      return 'OK';
    return '?';
  }

  private fmtFrame(ecu: SimEcu, data: readonly number[], wide: boolean): string {
    const sep = this.spaces ? ' ' : '';
    const id = ecu.spec.response;
    const head = !this.headers
      ? ''
      : wide
        ? ['00', '00', `0${id[0]}`, id.slice(1)].join(sep) + sep
        : id + sep;
    return head + data.map(hx).join(sep);
  }

  private executeRequest(raw: string, cmd: string, t0: number): void {
    // Host → adapter uplink.
    const t = t0 + this.rng.uniform('ble.up', this.model.upMs);
    let hex = cmd;
    let count = 0;
    if (hex.length % 2 === 1) {
      count = Number.parseInt(hex.slice(-1), 16);
      hex = hex.slice(0, -1);
    }
    const bytes = bytesOf(hex);
    const functional = this.header === '7DF';
    if (bytes.length > (this.caf ? 7 : 8)) {
      this.reply(t + 3, raw, '?');
      return;
    }
    let frame: number[];
    if (this.caf) {
      frame = [bytes.length, ...bytes];
    } else {
      frame = bytes;
      // The clone's raw-frame fault (see FaultModel.corruptFullFrames). A short first or consecutive frame goes out
      // padded with 00 (the ELM filler default), so a trimmed frame reaches the module whole.
      if (frame.length === 8 && this.model.corruptFullFrames)
        frame = [...frame.slice(0, 7), this.fcData[0] ?? 0x30];
      else if (frame.length < 8 && ((frame[0] ?? 0) >> 4 === 1 || (frame[0] ?? 0) >> 4 === 2))
        frame = [...frame, ...Array<number>(8 - frame.length).fill(0)];
    }
    const pci = (frame[0] ?? 0) >> 4;
    const topLevel = this.caf || pci === 0 || pci === 1;
    const transfer = !topLevel;
    const target = functional ? undefined : this.ecu(this.header);
    const key = this.header;

    // ---- discipline (BRIEF §5 criterion 6): measured before this request changes the state ----
    if (topLevel && !this.searchPending) {
      if (this.atSinceRequest) this.discipline.afterAtNoSearch++;
      else if (t0 - this.lastPromptAt > 20) this.discipline.lockedAfterIdle++;
    }
    this.atSinceRequest = false;
    if (!transfer && !this.searchPending && !this.stale && t0 - this.lastPromptAt > this.model.staleIdleMs)
      this.stale = 'idle';

    // ---- path and drop decision (BRIEF §2.3) ----
    let path: WireTx['path'];
    let txAt = t;
    let dropped: DropReason | null = null;
    let searching = false;
    const prevSilent = this.lastSilent.get(key) ?? false;
    if (transfer) {
      path = 'transfer';
      const isFc = pci === 3;
      const sinceFc = this.sinceFc.get(key) ?? 0;
      const p = isFc ? this.model.pRxFc : sinceFc === 0 ? this.model.pFirstCf : this.model.pMidCf;
      this.sinceFc.set(key, sinceFc + 1);
      if (this.rng.chance('drop.transfer', p)) dropped = isFc ? 'rx-fc' : 'cf';
    } else if (this.searchPending) {
      path = 'search';
      searching = true;
      const fast = this.rng.chance(
        'search.class',
        prevSilent ? this.model.pFastSearchAfterSilent : this.model.pFastSearch,
      );
      txAt = t + this.rng.uniform('search.delay', fast ? this.model.fastSearchMs : this.model.slowSearchMs);
      const p = this.searchSilent.get(key) ? this.model.pSearchAfterSilent : this.model.pSearchOk;
      if (this.rng.chance('drop.search', p)) dropped = 'search';
      this.stale = null;
    } else if (this.stale) {
      path = 'stale';
      if (this.rng.chance('drop.stale', this.model.pStale))
        dropped = this.stale === 'idle' ? 'stale-idle' : 'stale-at';
      this.stale = null;
    } else {
      path = 'locked';
      const prev = hexOf(this.lastReply.get(key) ?? []);
      const req = hexOf(frame.slice(1, 1 + ((frame[0] ?? 0) & 15)));
      const override = this.model.transitions.find(
        (x) => prev.startsWith(x.after) && req.startsWith(x.request),
      );
      if (this.rng.chance('drop.locked', override?.p ?? this.model.pLocked)) dropped = 'locked';
    }
    if (pci === 1 || this.caf || pci === 0) this.sinceFc.set(key, 0);
    this.txLog.push({ t: txAt, header: key, bytes: [...frame], topLevel, path, delivered: dropped === null });

    const searchingLine = searching ? `SEARCHING...\r` : '';
    if (searching) this.emitAt(txAt, searchingLine, false);
    const echo = this.echo ? `${raw}\r` : '';
    const noData = (at: number) => this.emitAt(at, `${echo}NO DATA\r\r>`, true);

    // ---- unfitted header: nobody acknowledges the frame ----
    if (!functional && !target) {
      this.lastSilent.set(key, true);
      if (searching) {
        const at = t + this.rng.uniform('search.unable', this.model.unableMs);
        this.emitAt(at, `${echo}UNABLE TO CONNECT\r>UNABLE TO CONNECT\r\r>`, true);
        return; // the search stays pending
      }
      noData(txAt + this.model.windowMs);
      return;
    }
    if (searching && dropped === null) this.searchPending = false;

    if (dropped) {
      this.truth.push({
        t: txAt,
        type: 'dropped',
        ecu: target?.spec.request ?? key,
        bytes: hexOf(frame),
        reason: dropped,
      });
      this.lastSilent.set(key, true);
      if (searching) this.searchSilent.set(key, true);
      if (searching && this.rng.chance('search.unableClass', this.model.pSearchUnable)) {
        // A search whose request nobody answered: the doubled UNABLE, and the search stays pending.
        const at = t + this.rng.uniform('search.unable', this.model.unableMs);
        this.emitAt(at, `${echo}UNABLE TO CONNECT\r>UNABLE TO CONNECT\r\r>`, true);
        return;
      }
      if (searching) this.searchPending = false;
      const extra =
        dropped === 'stale-idle' ? this.rng.uniform('drop.idleExtra', this.model.idleDropExtraMs) : 0;
      noData(txAt + this.model.windowMs + extra);
      return;
    }

    // ---- delivered: what the module(s) put on the bus ----
    const emissions: { ecu: SimEcu; e: Emission }[] = [];
    if (functional) {
      const req = frame.slice(1, 1 + ((frame[0] ?? 0) & 15));
      for (const ecu of this.ecus) for (const e of ecu.obd(req, txAt)) emissions.push({ ecu, e });
    } else if (target) {
      for (const e of target.receive(frame, txAt)) emissions.push({ ecu: target, e });
      for (const e of target.takeLate(txAt, txAt + this.model.windowMs)) emissions.push({ ecu: target, e });
    }
    const visible = emissions
      .filter(({ ecu }) => this.cra === null || ecu.spec.response === this.cra)
      .sort((x, y) => x.e.at - y.e.at);
    const first = visible[0];
    if (!first || first.e.at - txAt > this.model.windowMs) {
      for (const { ecu, e } of visible)
        this.truth.push({
          t: e.at,
          type: 'replyLost',
          ecu: ecu.spec.request,
          bytes: hexOf(e.data),
          reason: 'late',
        });
      this.lastSilent.set(key, true);
      if (searching) this.searchSilent.set(key, true);
      noData(txAt + this.model.windowMs);
      return;
    }
    this.lastSilent.set(key, false);
    if (searching) this.searchSilent.set(key, false);

    // CAF1 (functional readiness): the adapter does ISO-TP itself; single frames only here.
    const lines: string[] = [];
    let promptAt = first.e.at;
    if (this.caf) {
      for (const { ecu, e } of visible) {
        if (e.at - txAt > this.model.windowMs) break;
        lines.push(this.fmtFrame(ecu, e.data, searching));
        promptAt = e.at;
        this.noteShown(ecu, e.data, e.at);
        // A multi-frame answer (only the health rehearsal's OBD answers have them): with CAF1 the adapter sends its
        // own flow control and prints the consecutive frames, at most `rxCfCap` of them as on the live clone.
        if ((e.data[0] ?? 0) >> 4 === 1) {
          const cfs = ecu.flowControl([0x30, 0x00, 0x00], e.at + 1);
          for (const cf of cfs.slice(0, this.model.rxCfCap)) {
            lines.push(this.fmtFrame(ecu, cf.data, searching));
            promptAt = cf.at;
            this.noteShown(ecu, cf.data, cf.at);
          }
        }
      }
      if (!(count > 0 && lines.length >= count)) promptAt += this.model.windowMs;
      this.emitAt(promptAt, `${echo}${lines.join('\r')}\r\r>`, true);
      return;
    }

    // CAF0 (coding channel): frames printed raw with PCI; at most `rxCfCap` CFs per command.
    const ecu = first.ecu;
    const frames: Emission[] = [first.e];
    const firstPci = (first.e.data[0] ?? 0) >> 4;
    if (firstPci === 1) {
      // The adapter answers the first frame with its own flow control (ATFCSM1: the ATFCSD bytes).
      const fc = this.fcMode === 1 ? this.fcData : [0x30, 0x00, 0x00];
      frames.push(...ecu.flowControl(fc, first.e.at + 1));
    } else if (firstPci === 2) {
      frames.push(
        ...visible
          .slice(1)
          .filter((v) => v.ecu === ecu)
          .map((v) => v.e),
      );
    }
    if (firstPci === 1 || firstPci === 2) {
      const cfs = frames.filter((f) => (f.data[0] ?? 0) >> 4 === 2);
      const capped = cfs.slice(0, this.model.rxCfCap);
      const shownSoFar = this.shown.get(ecu.spec.request);
      const length =
        firstPci === 1
          ? (((first.e.data[0] ?? 0) & 15) << 8) | (first.e.data[1] ?? 0)
          : (shownSoFar?.length ?? 0);
      const have = (firstPci === 1 ? 6 : (shownSoFar?.bytes.length ?? 0)) + capped.length * 7;
      const complete = have >= length;
      const kept = firstPci === 1 ? [first.e, ...capped] : capped;
      for (const { at, data } of cfs.slice(this.model.rxCfCap))
        this.truth.push({
          t: at,
          type: 'replyLost',
          ecu: ecu.spec.request,
          bytes: hexOf(data),
          reason: 'after-prompt',
        });
      if (complete) {
        if (this.rng.chance('rx.lastCfLoss', this.model.pLastRxCfLoss) && kept.length > 1) {
          const lost = kept.pop();
          if (lost)
            this.truth.push({
              t: lost.at,
              type: 'replyLost',
              ecu: ecu.spec.request,
              bytes: hexOf(lost.data),
              reason: 'after-prompt',
            });
          promptAt = (kept.at(-1)?.at ?? first.e.at) + this.model.windowMs;
        } else promptAt = kept.at(-1)?.at ?? first.e.at;
      } else {
        promptAt = txAt + this.rng.uniform('rx.truncatedPrompt', this.model.truncatedPromptMs);
      }
      frames.length = 0;
      frames.push(...kept);
    }
    for (const f of frames) {
      lines.push(this.fmtFrame(ecu, f.data, searching));
      this.noteShown(ecu, f.data, f.at);
    }
    this.emitAt(promptAt, `${echo}${lines.join('\r')}\r\r>`, true);
  }

  /** Reassembles what the host was shown, per module, for the transition table and the host-saw log. */
  private noteShown(ecu: SimEcu, data: readonly number[], at: number): void {
    const id = ecu.spec.request;
    const pci = (data[0] ?? 0) >> 4;
    let pdu: number[] | null = null;
    if (pci === 0) pdu = data.slice(1, 1 + ((data[0] ?? 0) & 15));
    else if (pci === 1) {
      this.shown.set(id, { length: (((data[0] ?? 0) & 15) << 8) | (data[1] ?? 0), bytes: data.slice(2, 8) });
    } else if (pci === 2) {
      const s = this.shown.get(id);
      if (s) {
        s.bytes.push(...data.slice(1, 8));
        if (s.bytes.length >= s.length) {
          pdu = s.bytes.slice(0, s.length);
          this.shown.delete(id);
        }
      }
    } else if (pci === 3) {
      // The module's flow control: the host's next CF is the "FC → CF" transition.
      this.lastReply.set(id, [0x30]);
      this.sinceFc.set(id, 0);
    }
    if (pdu) {
      // A 7F xx 78 is not a reply for the transition table (it never preceded a send live).
      if (!(pdu[0] === 0x7f && pdu[2] === 0x78)) this.lastReply.set(id, pdu);
      this.hostSaw.push({ t: at, ecu: id, pdu });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The Kushaq as the traces saw it
// ---------------------------------------------------------------------------------------------------------------

/** A synthetic VIN (never a real one), the one the app's own docs use as a sample. */
export const SIM_VIN = 'MEXTEST0SAMPLE042';
const ascii = (s: string) => [...s].map((c) => hx(c.charCodeAt(0))).join('');

export interface KushaqOptions {
  /** DID contents keyed `${request}:${did}` (as the demo car seeds them). */
  values?: Record<string, string>;
  /** F187 part numbers by request id. */
  parts?: Record<string, string>;
  /** Extra logins by request id (recipe passwords), on top of each unit's default. */
  logins?: Record<string, readonly number[]>;
  /** Further fitted modules a recipe addresses (generic: hosted DIDs from `values`, logins from `logins`). */
  modules?: readonly { request: string; response: string }[];
  model?: Partial<FaultModel>;
}

/**
 * BCM 70E/778, cluster 714/77E (serves the VIN), B7 732/79C, HVAC 746/7B0, gateway 710/77A, ABS 713/77D, MIB
 * 773/7DD and the engine/transmission on 7DF → 7E8/7E9. Unfitted 74A/74C/74D are simply absent. Logins are
 * synthetic defaults plus whatever the recipes under test name.
 */
export function kushaqEcus(opts: KushaqOptions = {}): EcuSpec[] {
  const model = { ...DEFAULT_FAULT_MODEL, ...opts.model };
  const base: EcuSpec[] = [
    { name: 'BCM', request: '70E', response: '778', logins: [31347], pendingReads: ['0560'] },
    {
      name: 'CLU',
      request: '714',
      response: '77E',
      logins: [47115],
      seedPerRequest: model.cluSeedPerRequest,
    },
    {
      name: 'B7',
      request: '732',
      response: '79C',
      logins: [20103],
      ...(model.b7_0574_silent ? { silentWrites: ['0574'] } : {}),
    },
    {
      name: 'HVAC',
      request: '746',
      response: '7B0',
      logins: [20103],
      writesNeedSecurity: model.hvacNeedsSecurity,
    },
    { name: 'GW', request: '710', response: '77A', logins: [20103] },
    { name: 'ABS', request: '713', response: '77D', logins: [20103] },
    { name: 'MIB', request: '773', response: '7DD', logins: [20103] },
    { name: 'ENG', request: '7E0', response: '7E8', pad: 0x00, obd: true },
    { name: 'TCU', request: '7E1', response: '7E9', obd: true },
  ];
  for (const m of opts.modules ?? []) {
    if (!base.some((b) => b.request === m.request.toUpperCase()))
      base.push({
        name: m.request.toUpperCase(),
        request: m.request.toUpperCase(),
        response: m.response.toUpperCase(),
      });
  }
  const hvacOnly = new Set(['04FC', '04FE', '0600']);
  return base.map((spec) => {
    const dids: Record<string, string> = {
      F187: ascii(opts.parts?.[spec.request] ?? `SIM${spec.request}0000`),
      F1A5: 'AABBCCDDEEFF',
    };
    if (spec.name === 'CLU') dids.F190 = ascii(SIM_VIN);
    if (spec.name === 'HVAC') {
      dids['04FC'] = '00';
      dids['04FE'] = '00';
      dids['0600'] = '00'.repeat(33);
      for (const d of Object.keys(dids)) if (!hvacOnly.has(d)) delete dids[d];
    }
    for (const [k, v] of Object.entries(opts.values ?? {})) {
      const [req, did] = k.split(':');
      if (req?.toUpperCase() === spec.request && did) dids[did.toUpperCase()] = v.toUpperCase();
    }
    const logins = [...(spec.logins ?? []), ...(opts.logins?.[spec.request] ?? [])];
    return { ...spec, dids, logins: [...new Set(logins)] };
  });
}
