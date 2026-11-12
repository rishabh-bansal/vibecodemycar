import type { Transport } from './types.ts';
import type { Clock } from '../util/clock.ts';

export interface RecordedExchange {
  cmd: string;
  /** Raw text the adapter sent, ideally ending with '>'. */
  rx: string;
  /** Original time from first byte to prompt, if known (ms). */
  durationMs?: number;
  /** The adapter never sent its prompt (recorded timeout): replay hangs until interrupted. */
  hang?: boolean;
}

export interface ReplayOptions {
  clock: Clock;
  /** Delay used when an exchange has no recorded duration. */
  defaultLatencyMs?: number;
  /** Answer for commands never recorded: AT commands get "OK", OBD requests "NO DATA". */
  synthesizeMissing?: boolean;
  name?: string;
  id?: string;
}

/**
 * Plays recorded adapter replies back. Each command cycles through its recorded
 * variants in order, so a retry gets the next real reply (a truncated 0902 can
 * be followed by a complete one, exactly as on the car).
 */
export class ReplayTransport implements Transport {
  readonly kind = 'replay' as const;
  readonly maxWrite = 64;
  readonly name: string;
  readonly id: string;
  isOpen = false;
  private byCmd = new Map<string, RecordedExchange[]>();
  private cursor = new Map<string, number>();
  private inbuf = '';
  private hanging = false;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<(r: string) => void>();
  private readonly clock: Clock;
  private readonly latency: number;
  private readonly synth: boolean;
  readonly served: { cmd: string; recorded: boolean }[] = [];

  constructor(exchanges: RecordedExchange[], opts: ReplayOptions) {
    for (const e of exchanges) {
      const k = norm(e.cmd);
      const list = this.byCmd.get(k) ?? [];
      list.push(e);
      this.byCmd.set(k, list);
    }
    this.clock = opts.clock;
    this.latency = opts.defaultLatencyMs ?? 60;
    this.synth = opts.synthesizeMissing ?? true;
    this.name = opts.name ?? 'Recorded capture';
    this.id = opts.id ?? 'replay';
  }

  commands(): string[] {
    return [...this.byCmd.keys()];
  }

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.isOpen = false;
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
    const text = String.fromCharCode(...data);
    if (this.hanging) {
      // any character interrupts a busy ELM327
      this.hanging = false;
      this.inbuf = '';
      void this.emit('STOPPED\r\r>', 5);
      return;
    }
    for (const ch of text) {
      if (ch === '\r') {
        const cmd = this.inbuf;
        this.inbuf = '';
        void this.answer(cmd);
      } else this.inbuf += ch;
    }
    // an interrupt character with no CR: answer like a stopped ELM
    if (!text.includes('\r') && text.length === 1 && text !== ' ') {
      this.inbuf = '';
      void this.emit('STOPPED\r\r>', 5);
    }
  }

  private async answer(raw: string): Promise<void> {
    const k = norm(raw);
    const list = this.byCmd.get(k);
    if (list && list.length) {
      const i = this.cursor.get(k) ?? 0;
      this.cursor.set(k, i + 1);
      const ex = list[i % list.length]!;
      this.served.push({ cmd: k, recorded: true });
      if (ex.hang) {
        this.hanging = true;
        if (ex.rx) await this.emit(ex.rx.replace(/>/g, ''), 20);
        return;
      }
      const rx = ex.rx.endsWith('>') ? ex.rx : ex.rx + '\r\r>';
      await this.emit(rx, Math.min(ex.durationMs ?? this.latency, 2000));
      return;
    }
    this.served.push({ cmd: k, recorded: false });
    if (!this.synth) return;
    if (k.startsWith('AT')) {
      if (k === 'ATZ' || k === 'ATI') {
        const ati = this.byCmd.get('ATI')?.[0]?.rx ?? 'ELM327\r\r>';
        await this.emit(ati.endsWith('>') ? ati : ati + '\r\r>', this.latency);
      } else await this.emit('OK\r\r>', 10);
      return;
    }
    await this.emit('NO DATA\r\r>', this.latency);
  }

  private async emit(text: string, delayMs: number): Promise<void> {
    await this.clock.sleep(delayMs);
    if (!this.isOpen) return;
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
    for (const cb of this.dataCbs) cb(bytes);
  }
}

const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
