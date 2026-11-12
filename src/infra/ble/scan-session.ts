import type { ScannedDevice } from '../../domain/adapters/likely.ts';
import {
  buildView,
  displayOrder,
  type LastAdapter,
  mergeSighting,
  type ScanView,
  type Sightings,
} from '../../domain/adapters/scan-list.ts';
import type { BleScanner, ScanError, ScanFailure, ScanHandle } from './scanner.ts';

/** A scan runs this long, then stops by itself; RESCAN starts a new one. */
export const SCAN_MS = 10_000;

export interface ScanState {
  phase: 'idle' | 'scanning' | 'done' | 'error';
  error?: ScanFailure;
  view: ScanView;
}

export interface ScanSessionOptions {
  lastUsed?: LastAdapter;
  durationMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const EMPTY: ScanView = { likely: [], other: [], count: 0 };

/**
 * One picker's scanning: starts the scanner, merges what it reports by device id, stops after {@link SCAN_MS},
 * and holds the list's order still while a finger is on it (signal strengths keep updating). Framework-free;
 * the sheet reads it through `subscribe`/`getState`.
 */
export class ScanSession {
  private state: ScanState = { phase: 'idle', view: EMPTY };
  private seen: Sightings = new Map();
  private order: string[] = [];
  private frozen: readonly string[] | undefined;
  private handle: ScanHandle | undefined;
  private timer: unknown;
  private run = 0;
  private readonly listeners = new Set<() => void>();
  private readonly durationMs: number;
  private readonly later: (cb: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private lastUsed: LastAdapter | undefined;
  private readonly scanner: BleScanner;

  constructor(scanner: BleScanner, options: ScanSessionOptions = {}) {
    this.scanner = scanner;
    this.lastUsed = options.lastUsed;
    this.durationMs = options.durationMs ?? SCAN_MS;
    this.later = options.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.cancel =
      options.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  getState = (): ScanState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Starts (or restarts) a scan with an empty list. */
  start(): void {
    this.halt();
    const run = ++this.run;
    this.seen = new Map();
    this.order = [];
    this.frozen = undefined;
    this.state = { phase: 'scanning', view: EMPTY };
    this.emit();
    this.timer = this.later(() => {
      if (run !== this.run || this.state.phase !== 'scanning') return;
      this.halt();
      this.state = { ...this.state, phase: 'done' };
      this.emit();
    }, this.durationMs);
    this.handle = this.scanner.scan(
      (device) => {
        if (run === this.run && this.state.phase === 'scanning') this.sighted(device);
      },
      (error: ScanError) => {
        if (run !== this.run) return;
        this.halt();
        this.state = { ...this.state, phase: 'error', error: error.code };
        this.emit();
      },
    );
  }

  /** RESCAN: a fresh scan, list cleared. */
  rescan(): void {
    this.start();
  }

  /** Stops scanning and keeps the list (closing the sheet, or a tap to connect). */
  stop(): void {
    const scanning = this.state.phase === 'scanning';
    this.halt();
    this.run++;
    if (scanning) {
      this.state = { ...this.state, phase: 'done' };
      this.emit();
    }
  }

  /** A finger is on the list: rows keep their places until it lifts. */
  hold(): void {
    this.frozen ??= this.order;
  }

  release(): void {
    if (!this.frozen) return;
    this.frozen = undefined;
    this.relayout();
  }

  get held(): boolean {
    return this.frozen !== undefined;
  }

  /** The last adapter that connected (pinned on top). */
  setLastUsed(lastUsed: LastAdapter | undefined): void {
    this.lastUsed = lastUsed;
    this.relayout();
  }

  private sighted(device: ScannedDevice): void {
    this.seen = mergeSighting(this.seen, device);
    this.relayout();
  }

  private relayout(): void {
    this.order = displayOrder(this.seen, this.lastUsed, this.frozen);
    this.state = { ...this.state, view: buildView(this.seen, this.order, this.lastUsed) };
    this.emit();
  }

  private halt(): void {
    this.handle?.stop();
    this.handle = undefined;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
