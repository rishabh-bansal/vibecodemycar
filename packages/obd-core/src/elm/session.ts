import type { Transport } from '../transport/types.ts';
import { realClock, type Clock } from '../util/clock.ts';
import { ascii, toHex } from '../util/hex.ts';
import { normalizeReply, type NormalizedReply } from './normalize.ts';

export interface RecoveryResult {
  ok: boolean;
  /** What was sent to get the prompt back, in order. Never a lone CR. */
  steps: string[];
  durationMs: number;
  discarded: string;
}

export interface ElmReply extends NormalizedReply {
  cmd: string;
  txHex: string;
  rxRaw: string;
  rxHex: string;
  startedAt: number;
  firstByteAt: number | null;
  endedAt: number;
  durationMs: number;
  timeoutMs: number;
  status: 'ok' | 'timeout' | 'closed';
  /** Bytes that were waiting in the buffer before this command was sent (flushed, logged). */
  staleBefore: string;
  recovery?: RecoveryResult;
}

export interface WireEvent {
  dir: 'tx' | 'rx' | 'stale';
  at: number;
  text: string;
}

export interface SessionOptions {
  clock?: Clock;
  /** Time allowed for the prompt after the recovery character. */
  recoveryWaitMs?: number;
  /** Quiet time used to drain trailing bytes after recovery. */
  drainQuietMs?: number;
  onWire?: (e: WireEvent) => void;
}

export interface ElmTransaction {
  send(command: string, timeoutMs: number): Promise<ElmReply>;
  /** Passive CAN monitoring, interrupted with X once the caller has a complete frame or the deadline expires. */
  monitor(until: (raw: string) => boolean, timeoutMs: number): Promise<ElmReply>;
  /**
   * Listens without sending anything, for lines the adapter prints on its own (a final reply after a response-
   * pending, on adapters without ATMA). Ends when `until` accepts the data or the deadline passes; never interrupts.
   */
  listen(until: (raw: string) => boolean, timeoutMs: number): Promise<ElmReply>;
}

/**
 * One ELM327 command in flight at a time, framed by the '>' prompt.
 * Every wait is checked against the clock, so a throttled timer can delay a
 * timeout but never turn it into an unbounded hang. On timeout the session
 * interrupts the ELM with a single character, waits for '>', flushes and resyncs.
 */
export class ElmSession {
  readonly clock: Clock;
  private buf = '';
  private inFlight = false;
  private chain: Promise<unknown> = Promise.resolve();
  private notify: (() => void) | null = null;
  private closed = false;
  private unsub: (() => void)[] = [];
  private readonly recoveryWaitMs: number;
  private readonly drainQuietMs: number;
  private readonly onWire?: (e: WireEvent) => void;
  /** Bytes that arrived while no command was in flight (late replies, other events). */
  readonly staleLog: { at: number; text: string }[] = [];
  lastCommand = '';
  stats = { commands: 0, timeouts: 0, recoveries: 0, recoveryFailures: 0, staleChunks: 0 };

  readonly transport: Transport;

  constructor(transport: Transport, opts: SessionOptions = {}) {
    this.transport = transport;
    this.clock = opts.clock ?? realClock;
    this.recoveryWaitMs = opts.recoveryWaitMs ?? 1200;
    this.drainQuietMs = opts.drainQuietMs ?? 120;
    this.onWire = opts.onWire;
    this.unsub.push(
      transport.onData((chunk) => this.onData(chunk)),
      transport.onClose(() => {
        this.closed = true;
        this.wake();
      }),
    );
  }

  dispose(): void {
    this.closed = true;
    this.wake();
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  get isClosed(): boolean {
    return this.closed || !this.transport.isOpen;
  }

  private onData(chunk: Uint8Array): void {
    const text = String.fromCharCode(...chunk);
    this.buf += text;
    this.onWire?.({ dir: this.inFlight ? 'rx' : 'stale', at: this.clock.now(), text });
    if (!this.inFlight) {
      this.stats.staleChunks++;
      this.staleLog.push({ at: this.clock.now(), text });
      if (this.staleLog.length > 200) this.staleLog.shift();
    }
    this.wake();
  }

  private wake(): void {
    const n = this.notify;
    this.notify = null;
    n?.();
  }

  private dataSignal(): Promise<void> {
    return new Promise((r) => (this.notify = r));
  }

  private async writeAscii(s: string): Promise<void> {
    const bytes = ascii(s);
    this.onWire?.({ dir: 'tx', at: this.clock.now(), text: s });
    for (let i = 0; i < bytes.length; i += this.transport.maxWrite) {
      await this.transport.write(bytes.subarray(i, i + this.transport.maxWrite));
    }
  }

  /** Waits until the buffer holds a '>' or the deadline passes (clock-checked). */
  private async waitForPrompt(deadline: number, until?: (raw: string) => boolean): Promise<boolean> {
    const timer = this.clock.sleep(Math.max(0, deadline - this.clock.now()));
    let interrupted = false;
    for (;;) {
      if (this.buf.includes('>')) return true;
      if (this.closed) return false;
      if (this.clock.now() >= deadline) return false;
      if (until && !interrupted && until(this.buf)) {
        interrupted = true;
        await this.writeAscii('X');
        continue;
      }
      await Promise.race([this.dataSignal(), timer]);
    }
  }

  /** Discards bytes until the line has been quiet for drainQuietMs (bounded). */
  private async drain(maxMs: number): Promise<string> {
    let taken = '';
    const end = this.clock.now() + maxMs;
    for (;;) {
      taken += this.buf;
      this.buf = '';
      const before = taken.length;
      const quietUntil = Math.min(end, this.clock.now() + this.drainQuietMs);
      const timer = this.clock.sleep(Math.max(0, quietUntil - this.clock.now()));
      while (this.clock.now() < quietUntil && this.buf.length === 0 && !this.closed) {
        await Promise.race([this.dataSignal(), timer]);
      }
      taken += this.buf;
      this.buf = '';
      if (taken.length === before || this.clock.now() >= end || this.closed) return taken;
    }
  }

  /**
   * Gets the prompt back after a timeout. Step 1: one interrupt character ('X');
   * a busy ELM prints STOPPED and '>'. Step 2: if the ELM was idle and only the
   * prompt was lost, 'X' sits in its input buffer, so "ATI\r" completes either
   * "XATI" (answered with '?') or "ATI". A lone CR is never sent: it would repeat
   * the last command.
   */
  async recover(): Promise<RecoveryResult> {
    const t0 = this.clock.now();
    const steps: string[] = [];
    let discarded = this.buf;
    this.buf = '';
    this.stats.recoveries++;
    const attempt = async (payload: string, waitMs: number) => {
      steps.push(JSON.stringify(payload));
      await this.writeAscii(payload);
      return this.waitForPrompt(this.clock.now() + waitMs);
    };
    let ok = !this.closed && (await attempt('X', this.recoveryWaitMs));
    if (!ok && !this.closed) ok = await attempt('ATI\r', this.recoveryWaitMs * 1.5);
    if (!ok && !this.closed) ok = await attempt('X', this.recoveryWaitMs);
    discarded += await this.drain(600);
    if (!ok) this.stats.recoveryFailures++;
    return { ok, steps, durationMs: this.clock.now() - t0, discarded };
  }

  /** Sends one command and returns everything up to its prompt. Serialised. */
  send(cmd: string, timeoutMs: number): Promise<ElmReply> {
    return this.transaction(tx => tx.send(cmd, timeoutMs));
  }

  /** Holds the command queue for a complete diagnostic conversation, including configuration and restoration. */
  transaction<T>(work: (tx: ElmTransaction) => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      let active = true, tail: Promise<unknown> = Promise.resolve();
      const dispatch = (cmd: string, timeoutMs: number, until?: (raw: string) => boolean): Promise<ElmReply> => {
        if (!active) return Promise.reject(new Error('This ELM transaction has ended.'));
        const pending = tail.then(() => this.sendNow(cmd, timeoutMs, until));
        tail = pending.catch(() => undefined);
        return pending;
      };
      try {
        const listen = (until: (raw: string) => boolean, timeoutMs: number): Promise<ElmReply> => {
          if (!active) return Promise.reject(new Error('This ELM transaction has ended.'));
          const pending = tail.then(() => this.listenNow(until, timeoutMs));
          tail = pending.catch(() => undefined);
          return pending;
        };
        return await work({ send: (cmd, timeoutMs) => dispatch(cmd, timeoutMs), monitor: (until, timeoutMs) => dispatch('ATMA', timeoutMs, until), listen });
      } finally {
        active = false;
        await tail;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async listenNow(until: (raw: string) => boolean, timeoutMs: number): Promise<ElmReply> {
    const startedAt = this.clock.now();
    const deadline = startedAt + timeoutMs;
    const base = { cmd: '', txHex: '', startedAt, timeoutMs, staleBefore: '' };
    let firstByteAt: number | null = this.buf.length ? startedAt : null;
    const timer = this.clock.sleep(Math.max(0, timeoutMs));
    while (!this.closed && this.clock.now() < deadline && !until(this.buf)) {
      await Promise.race([this.dataSignal(), timer]);
      if (firstByteAt === null && this.buf.length) firstByteAt = this.clock.now();
    }
    const rxRaw = this.buf;
    this.buf = '';
    const endedAt = this.clock.now();
    const status = this.closed ? 'closed' : until(rxRaw) ? 'ok' : 'timeout';
    return { ...base, ...normalizeReply(rxRaw, ''), rxRaw, rxHex: toHex(ascii(rxRaw), ''), firstByteAt, endedAt, durationMs: endedAt - startedAt, status };
  }

  private async sendNow(cmd: string, timeoutMs: number, until?: (raw: string) => boolean): Promise<ElmReply> {
    const staleBefore = this.buf;
    this.buf = '';
    const startedAt = this.clock.now();
    const base = { cmd, txHex: toHex(ascii(cmd + '\r'), ''), startedAt, timeoutMs, staleBefore };
    if (this.isClosed) {
      return { ...base, ...normalizeReply('', cmd), rxRaw: '', rxHex: '', firstByteAt: null, endedAt: startedAt, durationMs: 0, status: 'closed' };
    }
    this.inFlight = true;
    this.stats.commands++;
    this.lastCommand = cmd;
    let firstByteAt: number | null = null;
    const watchFirst = this.transport.onData(() => {
      if (firstByteAt === null) firstByteAt = this.clock.now();
    });
    try {
      await this.writeAscii(cmd + '\r');
      const got = await this.waitForPrompt(startedAt + timeoutMs, until);
      watchFirst();
      if (got) {
        const idx = this.buf.indexOf('>');
        const rxRaw = this.buf.slice(0, idx + 1);
        this.buf = this.buf.slice(idx + 1);
        const endedAt = this.clock.now();
        return {
          ...base, ...normalizeReply(rxRaw, cmd), rxRaw, rxHex: toHex(ascii(rxRaw), ''),
          firstByteAt, endedAt, durationMs: endedAt - startedAt, status: 'ok',
        };
      }
      const partial = this.buf;
      this.buf = '';
      if (this.closed) {
        const endedAt = this.clock.now();
        return { ...base, ...normalizeReply(partial, cmd), rxRaw: partial, rxHex: toHex(ascii(partial), ''), firstByteAt, endedAt, durationMs: endedAt - startedAt, status: 'closed' };
      }
      this.stats.timeouts++;
      const endedAt = this.clock.now();
      const recovery = await this.recover();
      return {
        ...base, ...normalizeReply(partial, cmd), rxRaw: partial, rxHex: toHex(ascii(partial), ''),
        firstByteAt, endedAt, durationMs: endedAt - startedAt, status: 'timeout', recovery,
      };
    } finally {
      watchFirst();
      this.inFlight = false;
    }
  }
}
