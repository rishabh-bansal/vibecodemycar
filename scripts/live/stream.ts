/**
 * Live session stream: every adapter byte and coding event, printed as it happens and appended to
 * ~/.obdcraft/live/<sessionISO>.ndjson. stdout is compact and colorized (off when piped or NO_COLOR);
 * the NDJSON line carries the same facts in full.
 *
 * VINs never reach either sink: wire traffic inside `redacted()` is replaced by its length, so is every RX
 * line answering a `22 F190` request (and the host's flow control within it), and text that looks like a VIN is masked
 * wherever it appears.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WireEvent } from '@obdcraft/obd-core';
import type { WireTrace } from '../../src/domain/coding/audit.ts';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'),
  blue: paint('34'), magenta: paint('35'), cyan: paint('36'), bold: paint('1'),
};

/** 17 characters of the VIN alphabet (no I, O, Q) with at least one digit: masked wherever it appears. */
const VIN_LIKE = /\b(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b/g;
export const maskVins = (s: string) => s.replace(VIN_LIKE, '[VIN]');

const visible = (s: string) => s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

/** Coding events the writer and readiness checks report (wired by the apply/restore commands). */
export type LiveEventType =
  | 'session' | 'connect' | 'adapter' | 'note' | 'variant-selected' | 'readiness' | 'outcome'
  | 'backup' | 'coding' | 'plan' | 'upload' | 'result' | 'scan' | 'warn' | 'error';

/** A module read of F190 (the VIN), with or without spaces or a raw single-frame PCI. */
const VIN_REQUEST = /^(0[1-7]\s*)?22\s*F1\s*90/i;
/** The host's own flow control (CAF0): the VIN reply continues after it. */
const FLOW_CONTROL = /^30\s*[0-9A-F]{2}\s*[0-9A-F]{2}\s*$/i;

export class LiveLog {
  readonly file: string;
  readonly startedAt = new Date();
  private readonly t0 = performance.now();
  private last = this.t0;
  private redactDepth = 0;
  /** The last command read F190 (or continued its reply): its RX lines are hidden. */
  private vinReply = false;
  private vinAt = Number.NEGATIVE_INFINITY;

  readonly command: string;

  constructor(logDir: string, command: string) {
    this.command = command;
    mkdirSync(logDir, { recursive: true });
    this.file = join(logDir, `${this.startedAt.toISOString().replace(/:/g, '-')}.ndjson`);
  }

  private stamp(): { ms: number; dt: number; prefix: string } {
    const now = performance.now();
    const ms = Math.round(now - this.t0);
    const dt = Math.round(now - this.last);
    this.last = now;
    return { ms, dt, prefix: color.dim(`${`+${ms}`.padStart(7)}ms ${`Δ${dt}`.padStart(6)}ms`) };
  }

  private append(obj: Record<string, unknown>): void {
    try {
      appendFileSync(this.file, `${maskVins(JSON.stringify({ t: new Date().toISOString(), ...obj }))}\n`);
    } catch {
      // A full disk or a removed directory must not stop the session.
    }
  }

  /** ElmSession `onWire`: one line per TX command and per RX/stale chunk. */
  readonly wire = (e: WireEvent): void => {
    const { ms, dt, prefix } = this.stamp();
    if (e.dir === 'tx') {
      const cmd = e.text.trim();
      if (VIN_REQUEST.test(cmd)) {
        this.vinReply = true;
        this.vinAt = performance.now();
      } else if (!FLOW_CONTROL.test(cmd)) this.vinReply = false;
    }
    // Late bytes shortly after a VIN read may be its reply.
    const lateVin = e.dir === 'stale' && performance.now() - this.vinAt < 10_000;
    const hidden = (this.redactDepth > 0 || this.vinReply || lateVin) && e.dir !== 'tx';
    const text = hidden ? `[redacted ${e.text.length} chars]` : maskVins(e.text);
    const tag = e.dir === 'tx' ? color.cyan('TX') : e.dir === 'rx' ? color.green('RX') : color.yellow('ST');
    const body = e.dir === 'tx' ? color.bold(visible(text)) : visible(text);
    console.log(`${prefix} ${tag} ${body}`);
    this.append({ kind: 'wire', ms, dt, dir: e.dir, text, ...(hidden ? { redacted: true } : {}) });
  };

  /** The link's `onWire` (WebBluetoothLink / ConnectionLogger form). */
  readonly trace = (e: WireTrace): void => this.wire({ dir: e.direction, at: e.elapsedMs, text: e.text });

  event(type: LiveEventType, message: string, data: Record<string, unknown> = {}): void {
    const { ms, dt, prefix } = this.stamp();
    const tint = type === 'error' ? color.red : type === 'warn' ? color.yellow : type === 'outcome' || type === 'result' ? color.green : type === 'plan' ? color.cyan : color.magenta;
    const extra = Object.keys(data).length ? ` ${color.dim(maskVins(JSON.stringify(data)))}` : '';
    console.log(`${prefix} ${tint(`[${type}]`)} ${maskVins(message)}${extra}`);
    this.append({ kind: 'event', ms, dt, type, message, data });
  }

  /** Runs `work` with RX wire text hidden (VIN reads). */
  async redacted<T>(work: () => Promise<T>): Promise<T> {
    this.redactDepth++;
    try {
      return await work();
    } finally {
      this.redactDepth--;
    }
  }
}
