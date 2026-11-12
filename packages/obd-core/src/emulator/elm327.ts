import type { Transport } from '../transport/types.ts';
import type { Clock } from '../util/clock.ts';
import { hex2 } from '../util/hex.ts';
import { parseProtocol, type ProtocolFamily } from '../can/frames.ts';
import { functionalHeader } from '../elm/link.ts';
import type { EcuModel } from './vehicle.ts';

export interface EmulatorOptions {
  clock: Clock;
  ecus: EcuModel[];
  identity?: string;
  device?: string;
  /** AT@2 identifier (programmed into branded adapters); unset = '?'. */
  identifier?: string;
  /** An STN chip: STI answers this ("STN2120 v5.6.5"), STDI answers `stnDevice`. Unset = a plain ELM ('?'). */
  stnChip?: string;
  stnDevice?: string;
  voltage?: () => number;
  /**
   * ELM protocol the car speaks: 6/8 CAN 11-bit, 7/9 CAN 29-bit (ECU ids "18DAF1xx"),
   * 1-5 J1850 / K-line (ECU ids are the source byte, e.g. "10").
   */
  protocol?: number;
  /** Probability that a consecutive frame is lost before it reaches the host (clone weakness). */
  cfLoss?: number;
  /** Loss when the host set a flow-control separation time >= 5 ms (ATFCSD); models a slower burst helping. */
  cfLossWithSeparation?: number;
  /** Probability, per request, that another tester's reply lands in our window. */
  foreignRate?: number;
  /** Probability that the adapter hangs (no prompt until interrupted). */
  hangRate?: number;
  /** Probability that the final '>' notification is lost (prompt never seen). */
  promptLossRate?: number;
  /** How the adapter treats service 01 requests with several PIDs. */
  multiPid?: 'ok' | 'reject' | 'first_only';
  /** Accepts the response-count digit (genuine ELM v1.3+); some clones do not. */
  responseCount?: boolean;
  /** Host link throughput in bytes per ms (BLE notifications) and per-notification overhead. */
  bytesPerMs?: number;
  notifyBytes?: number;
  /** Time for one write to reach the adapter. */
  writeLatencyMs?: number;
  /** Deterministic randomness for tests. */
  random?: () => number;
  name?: string;
  id?: string;
  /** Time origin for the vehicle model (seconds); lets demo playback start mid-drive. */
  startSeconds?: number;
  /**
   * The car's bus is asleep (ignition off, or modules still waking): nothing acknowledges a frame. The adapter then
   * answers UNABLE TO CONNECT — after its whole protocol search on automatic protocol (~4.2 s, printed twice by the
   * live ELM327 v2.1 clone), at once on a fixed protocol — as the live adapter did on 2026-10-25.
   */
  asleep?: () => boolean;
  /**
   * Responders the adapter displays in the four-token form "00 00 07 78" instead of "778" (the live clone did this
   * for the BCM after an automatic protocol search, 2026-10-23).
   */
  wideHeaders?: readonly string[];
}

/** Live ELM327 v2.1 clone: a failed automatic search took about 4.2 s (2026-10-25). */
export const FAILED_SEARCH_MS = 4200;

interface PendingResponse {
  cancel: () => void;
  /** False while the adapter is resetting (ATZ/WS): real hardware queues host input instead of aborting. */
  interruptible: boolean;
}

/**
 * ELM327 v2.1-style interpreter in front of simulated ECUs, with a timing model:
 * the adapter waits for more replies until its timeout unless the response-count
 * digit says how many to expect; adaptive timing shortens that wait; ATS0 makes
 * replies shorter on the BLE link; physical addressing means one ECU answers.
 * These are exactly the levers the throughput tuner pulls, so it can be tested.
 */
export class Elm327Emulator implements Transport {
  readonly kind = 'emulator' as const;
  readonly name: string;
  readonly id: string;
  readonly maxWrite = 20;
  isOpen = false;

  private readonly o: Required<Omit<EmulatorOptions, 'voltage' | 'random' | 'name' | 'id' | 'startSeconds' | 'identifier' | 'stnChip' | 'stnDevice'>> & Pick<EmulatorOptions, 'identifier' | 'stnChip' | 'stnDevice'> & {
    voltage: () => number;
    random: () => number;
  };
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<(r: string) => void>();
  private inbuf = '';
  private busy: PendingResponse | null = null;
  private lastCmd = '';
  private t0: number;

  // ELM state
  echo = true;
  linefeeds = false;
  spaces = true;
  headers = false;
  caf = true;
  adaptive: 0 | 1 | 2 = 1;
  st = 0x32;
  header: string;
  cra: string | null = null;
  private busInitDone = false;
  fcSeparationMs = 0;
  fcMode = 0;
  responsesEnabled = true;
  /** CAN filler byte (PP 26) and whether it is in force; off, short raw frames are padded with 0xAA. */
  canFiller = 0x00;
  canFillerOn = false;
  /** STN only: STCSEGT1, the chip segments an STPX PDU of more than 7 bytes itself. */
  stnSegmentTx = false;
  private rawRequest: { target: string; length: number; bytes: number[]; sequence: number; at: number } | null = null;
  protocolSet = 0;
  protocolFound = false;
  private latencyEstimate = 20;
  readonly log: { at: number; cmd: string; reply: string }[] = [];
  requestCount = 0;

  constructor(opts: EmulatorOptions) {
    this.o = {
      identity: 'ELM327 v2.1',
      device: 'OBDII to RS232 Interpreter',
      protocol: 6,
      cfLoss: 0,
      cfLossWithSeparation: 0,
      foreignRate: 0,
      hangRate: 0,
      promptLossRate: 0,
      multiPid: 'ok',
      responseCount: true,
      bytesPerMs: 2.5,
      notifyBytes: 20,
      writeLatencyMs: 8,
      asleep: () => false,
      wideHeaders: [],
      ...opts,
      voltage: opts.voltage ?? (() => 14.1),
      random: opts.random ?? Math.random,
    };
    this.name = opts.name ?? 'Vibecode my car emulator';
    this.id = opts.id ?? 'emulator';
    this.t0 = opts.clock.now() - (opts.startSeconds ?? 0) * 1000;
    this.header = functionalHeader(this.o.protocol);
  }

  get family(): ProtocolFamily {
    return parseProtocol(this.o.protocol.toString(16)).family;
  }

  get clock(): Clock {
    return this.o.clock;
  }

  /** Changes fault injection while running (tests, demo controls). */
  set(opts: Partial<Pick<EmulatorOptions, 'cfLoss' | 'foreignRate' | 'hangRate' | 'promptLossRate' | 'multiPid' | 'responseCount'>>): void {
    Object.assign(this.o, opts);
  }

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.busy?.cancel();
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
    if (!this.isOpen) throw new Error('emulator closed');
    const text = String.fromCharCode(...data);
    await this.o.clock.sleep(this.o.writeLatencyMs);
    for (const ch of text) this.onChar(ch);
  }

  private pendingInput = '';
  private onChar(ch: string): void {
    if (this.busy) {
      if (!this.busy.interruptible) {
        // mid-reset: queue the byte like a UART FIFO, run it once the banner has gone out
        this.pendingInput += ch;
        return;
      }
      // any character interrupts a busy ELM327 — like hardware, the char is
      // consumed as the stop signal and the response aborts
      this.busy.cancel();
      this.busy = null;
      this.inbuf = '';
      this.emit('STOPPED\r\r>', 0, false, false);
      return;
    }
    if (ch === '\r') {
      const cmd = this.inbuf;
      this.inbuf = '';
      this.execute(cmd.trim() === '' ? this.lastCmd : cmd);
      return;
    }
    if (ch === '\n') return;
    this.inbuf += ch;
  }

  private nl(): string {
    return this.linefeeds ? '\r\n' : '\r';
  }

  /**
   * Sends text to the host in BLE-sized notifications, paced by link throughput.
   * The adapter counts as busy until the last chunk has gone out.
   */
  private emit(text: string, delayMs: number, dropPrompt = false, markBusy = true, interruptible = true, chunkBytes = this.o.notifyBytes): PendingResponse {
    const out = dropPrompt ? text.replace(/>$/, '') : text;
    let cancelled = false;
    const chunks: string[] = [];
    for (let i = 0; i < out.length; i += chunkBytes) chunks.push(out.slice(i, i + chunkBytes));
    const handle: PendingResponse = { cancel: () => (cancelled = true), interruptible };
    const run = async () => {
      if (delayMs > 0) await this.o.clock.sleep(delayMs);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        if (cancelled || !this.isOpen) return;
        await this.o.clock.sleep(Math.max(1, c.length / this.o.bytesPerMs));
        if (cancelled || !this.isOpen) return;
        if (i === chunks.length - 1 && this.busy === handle) this.busy = null;
        const bytes = Uint8Array.from(c, (x) => x.charCodeAt(0));
        for (const cb of this.dataCbs) cb(bytes);
      }
      if (this.busy === handle) this.busy = null;
      // host input queued while we were emitting replays now, in order
      if (this.pendingInput) {
        const queued = this.pendingInput;
        this.pendingInput = '';
        for (const ch of queued) this.onChar(ch);
      }
    };
    if (markBusy) this.busy = handle;
    void run();
    return handle;
  }

  private oneShotPromptLoss = false;

  /** The next reply loses its '>' on the link (the adapter itself is idle). */
  dropNextPrompt(): void {
    this.oneShotPromptLoss = true;
  }

  /** `whole`: the reply reaches the host in one notification (as the live clone's double UNABLE TO CONNECT did). */
  private respond(cmd: string, body: string, delayMs: number, whole = false): void {
    const echo = this.echo ? cmd + this.nl() : '';
    const text = `${echo}${body}${this.nl()}${this.nl()}>`;
    this.log.push({ at: this.o.clock.now(), cmd, reply: body });
    const dropPrompt = this.oneShotPromptLoss || this.o.random() < this.o.promptLossRate;
    this.oneShotPromptLoss = false;
    this.emit(text, delayMs, dropPrompt, true, true, whole ? text.length : this.o.notifyBytes);
  }

  private execute(raw: string): void {
    const cmd = raw.replace(/\s+/g, '').toUpperCase();
    this.lastCmd = raw;
    if (cmd.startsWith('AT')) {
      this.executeAt(raw, cmd.slice(2));
      return;
    }
    if (cmd === 'STI' && this.o.stnChip) return this.respond(raw, this.o.stnChip, 3);
    if (cmd === 'STDI' && this.o.stnChip && this.o.stnDevice) return this.respond(raw, this.o.stnDevice, 3);
    if (this.o.stnChip && /^STCSEGT[01]$/.test(cmd)) { this.stnSegmentTx = cmd.endsWith('1'); return this.respond(raw, 'OK', 3); }
    if (this.o.stnChip && cmd.startsWith('STPX')) return this.executeStpx(raw, cmd);
    if (!/^[0-9A-F]+$/.test(cmd) || cmd.length < 2) {
      this.respond(raw, '?', 3);
      return;
    }
    this.executeObd(raw, cmd);
  }

  private executeAt(raw: string, a: string): void {
    const ok = () => this.respond(raw, 'OK', 3);
    const m = (re: RegExp) => re.exec(a);
    let r: RegExpExecArray | null;
    if (a === 'Z' || a === 'WS') {
      this.echo = true; this.linefeeds = false; this.spaces = true; this.headers = false; this.adaptive = 1;
      this.st = 0x32; this.header = functionalHeader(this.o.protocol); this.cra = null; this.busInitDone = false; this.caf = true; this.fcSeparationMs = 0; this.fcMode = 0;
      this.responsesEnabled = true; this.rawRequest = null; this.stnSegmentTx = false;
      this.protocolFound = this.protocolSet !== 0;
      const echo = this.echo ? raw + '\r' : '';
      this.log.push({ at: this.o.clock.now(), cmd: raw, reply: this.o.identity });
      this.emit(`${echo}\r\r${this.o.identity}\r\r>`, a === 'Z' ? 700 : 300, false, true, false);
      return;
    }
    if (a === 'I') return this.respond(raw, this.o.identity, 3);
    if (a === '@1') return this.respond(raw, this.o.device, 3);
    if (a === '@2') return this.respond(raw, this.o.identifier ?? '?', 3);
    if (a === 'RV') return this.respond(raw, `${this.o.voltage().toFixed(1)}V`, 5);
    if (a === 'CS') return ok();
    if (a === 'IGN') return this.respond(raw, 'ON', 3);
    if (a === 'DPN') return this.respond(raw, `${this.protocolSet === 0 ? 'A' : ''}${this.protocolFound || this.protocolSet ? this.o.protocol.toString(16).toUpperCase() : '0'}`, 3);
    if (a === 'DP') {
      const name = parseProtocol(this.o.protocol.toString(16)).name;
      return this.respond(raw, this.protocolSet === 0 ? (this.protocolFound ? `AUTO, ${name}` : 'AUTO') : name, 3);
    }
    if ((r = m(/^E([01])$/))) { this.echo = r[1] === '1'; return ok(); }
    if ((r = m(/^L([01])$/))) { this.linefeeds = r[1] === '1'; return ok(); }
    if ((r = m(/^S([01])$/))) { this.spaces = r[1] === '1'; return ok(); }
    if ((r = m(/^H([01])$/))) { this.headers = r[1] === '1'; return ok(); }
    if ((r = m(/^M([01])$/))) return ok();
    if ((r = m(/^R([01])$/))) { this.responsesEnabled = r[1] === '1'; return ok(); }
    if (a === 'MA') { this.busy = { cancel: () => undefined, interruptible: true }; return; }
    if ((r = m(/^CAF([01])$/))) { this.caf = r[1] === '1'; if (this.caf) this.rawRequest = null; return ok(); }
    if ((r = m(/^AT([0-2])$/))) { this.adaptive = Number(r[1]) as 0 | 1 | 2; return ok(); }
    if ((r = m(/^ST([0-9A-F]{2})$/))) { this.st = parseInt(r[1]!, 16) || 0x32; return ok(); }
    if ((r = m(/^SPA?([0-9A-C])$/))) {
      this.protocolSet = parseInt(r[1]!, 16);
      this.protocolFound = this.protocolSet !== 0 && this.protocolSet === this.o.protocol;
      this.busInitDone = false;
      return ok();
    }
    if ((r = m(/^SH([0-9A-F]{3}|[0-9A-F]{6}|[0-9A-F]{8})$/))) { this.header = r[1]!; return ok(); }
    if (a === 'CRA') { this.cra = null; return ok(); }
    if ((r = m(/^CRA([0-9A-F]{3}|[0-9A-F]{8})$/))) { this.cra = r[1]!; return ok(); }
    if ((r = m(/^FCSH([0-9A-F]{3})$/))) return ok();
    if ((r = m(/^FCSD([0-9A-F]{6})$/))) { this.fcSeparationMs = parseInt(r[1]!.slice(4, 6), 16); return ok(); }
    if ((r = m(/^FCSM([01])$/))) { this.fcMode = Number(r[1]); return ok(); }
    if (a === 'D') return ok();
    if (a === 'PC') { this.busInitDone = false; return ok(); }
    if (a === 'AR' || a === 'AL' || a === 'NL') return ok();
    if ((r = m(/^D([01])$/))) return ok();
    if ((r = m(/^CFC([01])$/))) return ok();
    if ((r = m(/^PP26SV([0-9A-F]{2})$/))) { this.canFiller = parseInt(r[1]!, 16); return ok(); }
    if ((r = m(/^PP26(ON|OFF)$/))) { this.canFillerOn = r[1] === 'ON'; return ok(); }
    this.respond(raw, '?', 3);
  }

  /**
   * STN `STPX h:<hdr>,d:<hex>,r:<n>` (CAN 11-bit, ATCAF1): the PDU goes to `hdr` as one ISO-TP message — more than
   * 7 bytes only with STCSEGT1 — and the adapter stops after `n` answers.
   */
  private executeStpx(raw: string, cmd: string): void {
    const parts = new Map(cmd.slice(4).split(',').map((p) => [p.slice(0, 1), p.slice(2)] as const));
    const header = parts.get('H') ?? '';
    const data = parts.get('D') ?? '';
    const count = Number(parts.get('R') ?? '0');
    if (!/^[0-7][0-9A-F]{2}$/.test(header) || !/^(?:[0-9A-F]{2})+$/.test(data) || !this.caf || this.family !== 'can11') {
      return this.respond(raw, '?', 3);
    }
    const req: number[] = [];
    for (let i = 0; i < data.length; i += 2) req.push(parseInt(data.slice(i, i + 2), 16));
    if (req.length > 7 && !this.stnSegmentTx) return this.respond(raw, '?', 3);
    const saved = this.header;
    this.header = header;
    try {
      this.dispatchObd(raw, req, count);
    } finally {
      this.header = saved;
    }
  }

  private nowSeconds(): number {
    return (this.o.clock.now() - this.t0) / 1000;
  }

  private executeObd(raw: string, cmd: string): void {
    this.requestCount++;
    let hex = cmd;
    let count = 0;
    if (hex.length % 2 === 1) {
      if (!this.o.responseCount) return this.respond(raw, '?', 3);
      count = parseInt(hex.slice(-1), 16);
      hex = hex.slice(0, -1);
    }
    const req: number[] = [];
    for (let i = 0; i < hex.length; i += 2) req.push(parseInt(hex.slice(i, i + 2), 16));
    if (!this.caf && this.family === 'can11') return this.executeRawCan(raw, req);
    if (req.length > 7) return this.respond(raw, '?', 3);
    this.dispatchObd(raw, req, count);
  }

  private executeRawCan(raw: string, frame: number[]): void {
    // real adapters pad short raw frames to 8 bytes rather than rejecting them
    if (frame.length > 8) return this.respond(raw, '?', 3);
    while (frame.length < 8) frame.push(this.canFillerOn ? this.canFiller : 0xaa);
    const kind = frame[0]! >> 4;
    const ecu = this.o.ecus.find(e => e.requestId === this.header);
    if (this.o.asleep() || (!ecu && !this.protocolFound)) return this.unableToConnect(raw);
    if (!ecu) return this.respond(raw, this.responsesEnabled ? 'NO DATA' : '', this.responsesEnabled ? this.st * 4 : 1);
    // A frame that starts a transfer finds the protocol too: the module acknowledges it.
    if (kind !== 0) this.protocolFound = true;
    if (kind === 0) {
      const length = frame[0]! & 15;
      if (length < 1 || length > 7) return this.respond(raw, '?', 3);
      return this.dispatchObd(raw, frame.slice(1, 1 + length), 1);
    }
    if (kind === 1) {
      const length = ((frame[0]! & 15) << 8) | frame[1]!;
      if (length <= 7) return this.respond(raw, '?', 3);
      this.rawRequest = { target: this.header, length, bytes: frame.slice(2), sequence: 1, at: this.clock.now() };
      return this.respond(raw, this.formatFrame(ecu, [0x30, 0x0f, 5, 0, 0, 0, 0, 0]), 5);
    }
    if (kind === 2) {
      const request = this.rawRequest;
      if (!request || request.target !== this.header || (frame[0]! & 15) !== (request.sequence & 15) || this.clock.now() - request.at > 1000) {
        this.rawRequest = null;
        return this.respond(raw, 'DATA ERROR', 3);
      }
      request.bytes.push(...frame.slice(1)); request.sequence++; request.at = this.clock.now();
      // An ISO-TP receiver grants the next block after every BS (15) consecutive frames, as a real ECU does.
      if (request.bytes.length < request.length) {
        return (request.sequence - 1) % 15 === 0
          ? this.respond(raw, this.formatFrame(ecu, [0x30, 0x0f, 5, 0, 0, 0, 0, 0]), 5)
          : this.respond(raw, '', 1);
      }
      this.rawRequest = null;
      return this.dispatchObd(raw, request.bytes.slice(0, request.length), 1);
    }
    return this.respond(raw, 'NO DATA', 3);
  }

  private dispatchObd(raw: string, req: number[], count: number): void {
    let request = req;
    if (req[0] === 0x01 && req.length > 2 && this.family === 'legacy') return this.respond(raw, 'NO DATA', this.st * 4);
    if (req[0] === 0x01 && req.length > 2) {
      if (this.o.multiPid === 'reject') return this.respond(raw, 'NO DATA', 40);
      if (this.o.multiPid === 'first_only') request = req.slice(0, 2);
    }

    if (this.o.random() < this.o.hangRate) {
      // adapter wedges: no output until a character interrupts it
      this.busy = { cancel: () => undefined, interruptible: true };
      return;
    }

    const searching = !this.protocolFound;
    if (this.o.asleep()) return this.unableToConnect(raw);
    const legacy = this.family === 'legacy';
    // K-line wakes the ECU first: 5-baud init about 2.6 s (protocols 3, 4), fast init about 0.3 s (5)
    const initMs = legacy && !this.busInitDone ? (this.o.protocol === 5 ? 300 : 2600) : 0;
    const busInit = legacy && !this.busInitDone && !searching;
    this.busInitDone = true;
    const searchMs = (searching ? 1400 : 0) + initMs;
    this.protocolFound = true;
    const physical = this.header.toUpperCase() !== functionalHeader(this.o.protocol);
    const targets = physical ? this.o.ecus.filter((e) => e.requestId === this.header) : this.o.ecus;
    const t = this.nowSeconds();
    type Out = { at: number; ecu: EcuModel; frames: number[][]; ours: boolean };
    const outs: Out[] = [];
    for (const ecu of targets) {
      const resp = ecu.handle(request, t, physical);
      if (!resp) continue;
      const jitter = this.o.random() * 6;
      outs.push({ at: ecu.latencyMs + jitter, ecu, frames: this.framesFor(ecu, resp), ours: true });
    }
    if (!this.responsesEnabled) return this.respond(raw, '', 1);
    // A search that nobody answers finds no protocol: the adapter stays on automatic and searches again next time.
    if (searching && !outs.length && !legacy) return this.unableToConnect(raw, true);
    if (this.o.foreignRate > 0 && this.o.random() < this.o.foreignRate && this.o.ecus.length > 0) {
      const ecu = this.o.ecus[Math.floor(this.o.random() * this.o.ecus.length)]!;
      const foreign = ecu.handle([0x01, 0x0c], t, false) ?? [0x41, 0x0d, 0x00];
      outs.push({ at: this.o.random() * 30, ecu, frames: this.framesFor(ecu, foreign), ours: false });
    }
    outs.sort((a, b) => a.at - b.at);

    // flatten frames with arrival times; consecutive frames may be lost
    const lossRate = this.fcSeparationMs >= 5 && this.fcMode === 1 ? this.o.cfLossWithSeparation : this.o.cfLoss;
    const frameTimes: { at: number; ecu: EcuModel; data: number[]; isFirstOrSingle: boolean }[] = [];
    for (const o of outs) {
      let at = o.at;
      o.frames.forEach((f, i) => {
        if (legacy) {
          // each K-line message is its own reply: ~1 ms per byte at 10.4 kbaud plus the P2 gap
          if (i > 0) at += 15 + f.length * 1.1;
          frameTimes.push({ at, ecu: o.ecu, data: f, isFirstOrSingle: true });
          return;
        }
        const pci = f[0]! >> 4;
        if (pci === 2 && this.o.random() < lossRate) return;
        const spacing = pci === 2 ? Math.max(1, this.fcSeparationMs) * i : 0;
        frameTimes.push({ at: o.at + spacing, ecu: o.ecu, data: f, isFirstOrSingle: pci !== 2 });
      });
    }
    frameTimes.sort((a, b) => a.at - b.at);
    const visible = frameTimes.filter((f) => this.cra === null || f.ecu.id === this.cra);

    // the ELM stops listening when the response count is reached (counts every reply it sees)
    let cut = visible.length;
    if (count > 0) {
      let seen = 0;
      for (let i = 0; i < visible.length; i++) {
        if (visible[i]!.isFirstOrSingle) seen++;
        if (seen === count) {
          // a multi-frame reply is read to its end before stopping
          let j = i + 1;
          while (j < visible.length && !visible[j]!.isFirstOrSingle && visible[j]!.ecu === visible[i]!.ecu) j++;
          cut = j;
          break;
        }
      }
    }
    const stMs = this.st * 4;
    // A real ELM327 stops waiting ST (×4 ms) after the request: a module that first answers later is never shown
    // (NO DATA). The live Kushaq cluster's VIN reply was lost this way at ATST32.
    const shown = visible.length && (visible[0]?.at ?? 0) > stMs ? [] : visible.slice(0, cut);
    let waitMs: number;
    if (shown.length === 0) waitMs = stMs;
    else if (count > 0 && countReached(shown, count)) waitMs = shown[shown.length - 1]!.at + 2;
    else {
      const last = shown[shown.length - 1]!.at;
      const firstLatency = shown[0]!.at;
      this.latencyEstimate = this.latencyEstimate * 0.7 + firstLatency * 0.3;
      const after = this.adaptive === 0 ? stMs : this.adaptive === 1 ? Math.min(stMs, this.latencyEstimate * 2 + 25) : Math.min(stMs, this.latencyEstimate * 1.3 + 10);
      waitMs = last + after;
    }
    const lines = shown.map((f) => this.formatFrame(f.ecu, f.data));
    let body: string;
    if (shown.length === 0) body = 'NO DATA';
    else if (!this.headers && this.caf && !legacy) body = this.formatHeadersOff(shown.map((f) => f.data));
    else body = lines.join(this.nl());
    if (busInit) body = `BUS INIT: ...OK${this.nl()}${body}`;
    if (searching) body = `SEARCHING...${this.nl()}${body}`;
    this.respond(raw, body, searchMs + waitMs);
  }

  /** Nothing on the bus answered. `searched`: the adapter was on automatic protocol and ran its whole search. */
  private unableToConnect(raw: string, searched = !this.protocolFound): void {
    this.protocolFound = false;
    const nl = this.nl();
    // The live clone printed the result twice, each with its own prompt, after a failed search.
    if (!searched) return this.respond(raw, 'UNABLE TO CONNECT', 250);
    // Live, the whole answer reached the host in one notification when the search ended.
    this.respond(raw, `SEARCHING...${nl}UNABLE TO CONNECT${nl}>UNABLE TO CONNECT`, FAILED_SEARCH_MS, true);
  }

  private framesFor(ecu: EcuModel, payload: number[]): number[][] {
    return this.family === 'legacy' ? legacyMessages(payload).map((m) => this.legacyWrap(ecu, m)) : this.toFrames(payload, ecu.pad);
  }

  /** Header (3 bytes) + data + checksum, as a K-line or J1850 ECU sends it. */
  private legacyWrap(ecu: EcuModel, data: number[]): number[] {
    const src = parseInt(ecu.id, 16);
    const p = this.o.protocol;
    const head = p === 4 || p === 5 ? [0x80 | data.length, 0xf1, src] : [p === 1 ? 0x41 : 0x48, 0x6b, src];
    const msg = [...head, ...data];
    return [...msg, p === 1 || p === 2 ? j1850Crc(msg) : msg.reduce((a, b) => (a + b) & 0xff, 0)];
  }

  private toFrames(payload: number[], pad: number): number[][] {
    const fill = (f: number[]) => {
      while (f.length < 8) f.push(pad);
      return f;
    };
    if (payload.length <= 7) return [fill([payload.length, ...payload])];
    const frames: number[][] = [];
    const len = payload.length;
    frames.push(fill([0x10 | (len >> 8), len & 0xff, ...payload.slice(0, 6)]));
    let seq = 1;
    for (let i = 6; i < len; i += 7) {
      frames.push(fill([0x20 | (seq & 0x0f), ...payload.slice(i, i + 7)]));
      seq++;
    }
    return frames;
  }

  private formatFrame(ecu: EcuModel, data: number[]): string {
    const sep = this.spaces ? ' ' : '';
    if (this.family === 'legacy') return (this.headers ? data : data.slice(3, -1)).map(hex2).join(sep);
    const bytes = data.map(hex2).join(sep);
    if (!this.headers) return bytes;
    const wide = this.family === 'can29' ? ecu.id : this.o.wideHeaders.includes(ecu.id) ? ecu.id.padStart(8, '0') : null;
    const head = wide ? (wide.match(/../g) ?? []).join(sep) : ecu.id;
    return `${head}${sep}${bytes}`;
  }

  /** ATH0 with CAN auto-formatting: PCI removed; multi-frame shown as "LLL / 0: .. / 1: ..". */
  private formatHeadersOff(frames: number[][]): string {
    const sep = this.spaces ? ' ' : '';
    const out: string[] = [];
    for (const f of frames) {
      const pci = f[0]! >> 4;
      if (pci === 0) out.push(f.slice(1, 1 + (f[0]! & 15)).map(hex2).join(sep));
      else if (pci === 1) {
        const len = ((f[0]! & 15) << 8) | f[1]!;
        out.push(len.toString(16).toUpperCase().padStart(3, '0'));
        out.push(`0:${sep}${f.slice(2).map(hex2).join(sep)}`);
      } else if (pci === 2) out.push(`${(f[0]! & 15).toString(16).toUpperCase()}:${sep}${f.slice(1).map(hex2).join(sep)}`);
    }
    return out.join(this.nl());
  }
}

function countReached(shown: { isFirstOrSingle: boolean }[], count: number): boolean {
  return shown.filter((f) => f.isFirstOrSingle).length >= count;
}

/**
 * Splits a CAN-style response payload into J1979 non-CAN messages:
 * DTCs 3 per message with no count byte; service 09 items as "49 PID SEQ d d d d"
 * (VIN padded with leading zeros to 20 bytes); everything else one message.
 */
export function legacyMessages(payload: number[]): number[][] {
  const svc = payload[0]!;
  if (svc === 0x43 || svc === 0x47 || svc === 0x4a) {
    const codes = payload.slice(2);
    const out: number[][] = [];
    for (let i = 0; i < Math.max(codes.length, 1); i += 6) {
      const chunk = codes.slice(i, i + 6);
      while (chunk.length < 6) chunk.push(0);
      out.push([svc, ...chunk]);
    }
    return out;
  }
  if (svc === 0x49 && payload.length > 2) {
    const pid = payload[1]!;
    if (pid % 0x20 === 0) return [[0x49, pid, 0x01, ...payload.slice(2, 6)]];
    const data = payload.slice(3);
    while (data.length % 4 !== 0) data.unshift(0);
    const out: number[][] = [];
    for (let i = 0; i < data.length; i += 4) out.push([0x49, pid, i / 4 + 1, ...data.slice(i, i + 4)]);
    return out;
  }
  return [payload];
}

/** SAE J1850 CRC-8 (polynomial 0x1D, initial 0xFF, inverted). */
function j1850Crc(bytes: number[]): number {
  let crc = 0xff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff;
  }
  return crc ^ 0xff;
}
