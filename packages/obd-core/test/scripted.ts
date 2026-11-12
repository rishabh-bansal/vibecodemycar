import type { Transport } from '../src/transport/types.ts';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { ElmSession } from '../src/elm/session.ts';
import { ElmLink } from '../src/elm/link.ts';
import { parseProtocol } from '../src/can/frames.ts';

export interface ScriptedState {
  header: string;
  cra: string | null;
}
type ScriptedReply = string | { body: string; prompt: boolean; delayMs?: number };

/** A pretend ELM327: answers each command from a handler that knows the header currently set. */
export class ScriptedElm implements Transport {
  readonly kind = 'emulator' as const;
  readonly name = 'scripted';
  readonly id = 'scripted';
  readonly maxWrite = 512;
  isOpen = true;
  readonly log: { cmd: string; header: string }[] = [];
  readonly state: ScriptedState = { header: '7DF', cra: null };
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<(r: string) => void>();
  private readonly clock: VirtualClock;
  private readonly handler: (cmd: string, st: ScriptedState) => ScriptedReply;

  constructor(clock: VirtualClock, handler: (cmd: string, st: ScriptedState) => ScriptedReply) {
    this.clock = clock;
    this.handler = handler;
  }

  async open() { this.isOpen = true; }
  async close() { this.isOpen = false; for (const c of this.closeCbs) c('closed'); }
  onData(cb: (c: Uint8Array) => void) { this.dataCbs.add(cb); return () => this.dataCbs.delete(cb); }
  onClose(cb: (r: string) => void) { this.closeCbs.add(cb); return () => this.closeCbs.delete(cb); }

  async write(data: Uint8Array): Promise<void> {
    const text = String.fromCharCode(...data);
    for (const line of text.split('\r').filter(Boolean)) {
      const cmd = line.replace(/\s+/g, '').toUpperCase();
      this.log.push({ cmd, header: this.state.header });
      const m = /^ATSH([0-9A-F]+)$/.exec(cmd);
      if (m) this.state.header = m[1]!;
      if (cmd === 'ATCRA') this.state.cra = null;
      const c = /^ATCRA([0-9A-F]+)$/.exec(cmd);
      if (c) this.state.cra = c[1]!;
      const response = this.handler(cmd, this.state);
      const body = typeof response === 'string' ? (cmd.startsWith('AT') ? response || 'OK' : response) : response.body;
      this.clock.schedule(typeof response === 'string' ? 5 : response.delayMs ?? 5, () => {
        const bytes = new TextEncoder().encode(`${body}\r${typeof response === 'string' || response.prompt ? '\r>' : ''}`);
        for (const cb of this.dataCbs) cb(bytes);
      });
    }
  }

  /** Prints `text` later without any command (an adapter passing on a frame by itself, e.g. a final reply). */
  emitLater(text: string, delayMs: number): void {
    this.clock.schedule(delayMs, () => {
      const bytes = new TextEncoder().encode(`${text}\r`);
      for (const cb of this.dataCbs) cb(bytes);
    });
  }

  /** Commands sent while the given header was set. */
  sentTo(header: string): string[] {
    return this.log.filter((l) => l.header === header && !l.cmd.startsWith('AT')).map((l) => l.cmd);
  }
}

export function scriptedRig(handler: (cmd: string, st: ScriptedState) => ScriptedReply, protocol = '6') {
  const clock = new VirtualClock();
  const elm = new ScriptedElm(clock, handler);
  const session = new ElmSession(elm, { clock });
  const link = new ElmLink(session);
  link.protocol = parseProtocol(protocol);
  const run = <T>(p: Promise<T>) => runVirtual(clock, p);
  return { clock, elm, session, link, run };
}
