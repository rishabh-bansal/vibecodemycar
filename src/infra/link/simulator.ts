import type {
  CarLink,
  DidRead,
  DidWrite,
  IdentifyResult,
  MarkerWrite,
  ModuleAddress,
  ReadinessRead,
  SequenceSpec,
  WriteOptions,
} from '../../domain/coding/types.ts';

/**
 * A fake car. It behaves like an ECU and never decides whether anything "worked" —
 * that is the domain's job — so it can be driven into every awkward state the
 * real hardware has produced: late/missing acknowledgements, a store that
 * normalises what you wrote, dropped replies, a link that dies mid-write.
 */
export type SimWrite =
  | { kind: 'ack' } //                       applies exactly, acknowledges
  | { kind: 'ack-after-pending' } //          sends response-pending, then acknowledges, applies
  | { kind: 'nrc'; code: string } //          refuses, nothing changes
  | { kind: 'silent-applies' } //             pending, then no final answer — but the change landed
  | { kind: 'silent-drops' } //               pending, then no final answer — and nothing changed
  | { kind: 'ack-stores'; bytes: string } //  acknowledges but stores different bytes (ECU normalisation)
  | { kind: 'link-lost'; applied: boolean } // the link dies after the request left
  /** A preparation step stops the sequence: the data write never leaves (`reason` as the real writer reports it). */
  | { kind: 'not-sent'; detail: string; reason?: 'not-ready' };

export type SimRead = 'normal' | 'stale-once' | 'unreadable-after-write';

export interface SimOptions {
  /** `null` ⇒ the car does not report a VIN. */
  vin?: string | null;
  /** F187 part number per module request id. */
  parts?: Record<string, string>;
  /** DID contents keyed `${request}:${did}`. */
  values?: Record<string, string>;
  write?: SimWrite;
  /** Coding markers the write sequence reports (the real writer's F199/F198 outcomes). */
  markers?: MarkerWrite[];
  read?: SimRead;
  latencyMs?: number;
  pendingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  mode?: CarLink['mode'];
  canWrite?: boolean;
  banner?: string;
  /** Parked, engine off, ignition on, 12.6 V unless overridden (`null` = that value can't be read). */
  readiness?: { rpm?: number | null; speedKmh?: number | null; voltage?: number | null };
  /** Clock for evidence timestamps (tests share the domain's clock). */
  now?: () => Date;
}

const toHex = (text: string): string =>
  [...text].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');

export class SimulatedCar implements CarLink {
  readonly mode: CarLink['mode'];
  readonly canWrite: boolean;
  readonly banner: string;
  /** Every write that reached the "wire", in order — assertions use this to prove "never retransmitted". */
  readonly writes: { module: string; did: string; bytes: string; password: string | null }[] = [];
  readonly values = new Map<string, string>();
  closed = false;
  private readonly opts: SimOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  private wrote = false;
  private staleServed = false;
  private lastWrittenKey = '';
  private readonly preWrite = new Map<string, string>();

  constructor(opts: SimOptions = {}) {
    this.opts = opts;
    this.mode = opts.mode ?? 'demo';
    this.canWrite = opts.canWrite ?? true;
    this.banner = opts.banner ?? 'DEMO · simulated car — nothing is sent to a vehicle';
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (const [k, v] of Object.entries(opts.values ?? {})) this.values.set(k, v);
  }

  private async pause(ms = this.opts.latencyMs ?? 0): Promise<void> {
    if (ms > 0) await this.sleep(ms);
  }

  async identify(_bound?: ModuleAddress): Promise<IdentifyResult> {
    await this.pause();
    if (this.closed) return { kind: 'link-lost' };
    const vin = this.opts.vin === undefined ? 'MEXSIM00000000001' : this.opts.vin;
    return vin === null ? { kind: 'no-vin' } : { kind: 'ok', vin };
  }

  readinessReads = 0;

  async readiness(): Promise<ReadinessRead> {
    await this.pause();
    if (this.closed) return { kind: 'link-lost' };
    this.readinessReads++;
    const r = this.opts.readiness ?? {};
    return {
      kind: 'ok',
      at: (this.opts.now ?? (() => new Date()))().toISOString(),
      rpm: r.rpm === undefined ? 0 : r.rpm,
      speedKmh: r.speedKmh === undefined ? 0 : r.speedKmh,
      voltage: r.voltage === undefined ? 12.6 : r.voltage,
    };
  }

  async readDid(module: ModuleAddress, did: string): Promise<DidRead> {
    await this.pause();
    if (this.closed) return { kind: 'link-lost' };
    if (did === 'F187') {
      const part = this.opts.parts?.[module.request];
      return part ? { kind: 'ok', bytes: toHex(part) } : { kind: 'no-reply' };
    }
    const key = `${module.request}:${did}`;
    if (this.wrote && this.opts.read === 'unreadable-after-write') return { kind: 'no-reply' };
    const value = this.values.get(key);
    if (value === undefined) return { kind: 'nrc', code: '31' };
    if (this.wrote && this.opts.read === 'stale-once' && !this.staleServed && key === this.lastWrittenKey) {
      // A slow ECU still reports the pre-write bytes for a moment.
      this.staleServed = true;
      return { kind: 'ok', bytes: this.preWrite.get(key) ?? value };
    }
    return { kind: 'ok', bytes: value };
  }

  /** Steps a sequence run executed, in order — tests assert ritual fidelity from this. */
  readonly commands: string[] = [];

  async sequence(module: ModuleAddress, spec: SequenceSpec, options: WriteOptions): Promise<DidWrite> {
    await this.pause();
    if (this.closed) return { kind: 'link-lost' };
    if (options.signal?.aborted) return { kind: 'cancelled' };
    options.assertReady?.();
    for (const raw of [...spec.pre, ...spec.post]) this.commands.push(raw);
    const behaviour = this.opts.write ?? { kind: 'ack' };
    if (behaviour.kind === 'not-sent')
      return {
        kind: 'not-sent',
        detail: behaviour.detail,
        ...(behaviour.reason ? { reason: behaviour.reason } : {}),
      };
    if (behaviour.kind === 'nrc') return { kind: 'nrc', code: behaviour.code };
    options.onSend?.();
    if (behaviour.kind === 'link-lost') {
      this.closed = true;
      return { kind: 'link-lost' };
    }
    if (spec.write.kind === 'did') {
      const key = `${module.request}:${spec.write.did}`;
      this.writes.push({
        module: module.request,
        did: spec.write.did,
        bytes: spec.write.bytes,
        password: options.securityPassword,
      });
      this.wrote = true;
      this.lastWrittenKey = key;
      this.preWrite.set(key, this.values.get(key) ?? '');
      this.values.set(key, spec.write.bytes);
    } else {
      this.commands.push(`34:${spec.write.address}`);
    }
    if (behaviour.kind === 'ack-after-pending' || behaviour.kind === 'silent-applies') {
      options.onPending();
      await this.pause(this.opts.pendingMs ?? 0);
    }
    return { kind: 'acked' };
  }

  async writeDid(
    module: ModuleAddress,
    did: string,
    bytes: string,
    options: WriteOptions,
  ): Promise<DidWrite> {
    const result = await this.write(module, did, bytes, options);
    return this.opts.markers?.length && result.kind !== 'link-lost'
      ? { ...result, markers: this.opts.markers }
      : result;
  }

  private async write(
    module: ModuleAddress,
    did: string,
    bytes: string,
    options: WriteOptions,
  ): Promise<DidWrite> {
    await this.pause();
    if (this.closed) return { kind: 'link-lost' };
    if (options.signal?.aborted) return { kind: 'cancelled' };
    const behaviour = this.opts.write ?? { kind: 'ack' };
    if (behaviour.kind === 'not-sent')
      return {
        kind: 'not-sent',
        detail: behaviour.detail,
        ...(behaviour.reason ? { reason: behaviour.reason } : {}),
      };
    options.assertReady?.();
    options.onSend?.();
    const key = `${module.request}:${did}`;
    this.writes.push({ module: module.request, did, bytes, password: options.securityPassword });
    this.wrote = true;
    this.lastWrittenKey = key;
    this.preWrite.set(key, this.values.get(key) ?? '');

    const pending = async () => {
      options.onPending();
      await this.pause(this.opts.pendingMs ?? 0);
    };

    switch (behaviour.kind) {
      case 'ack':
        this.values.set(key, bytes);
        return { kind: 'acked' };
      case 'ack-after-pending':
        await pending();
        this.values.set(key, bytes);
        return { kind: 'acked' };
      case 'nrc':
        return { kind: 'nrc', code: behaviour.code };
      case 'silent-applies':
        await pending();
        this.values.set(key, bytes);
        return { kind: 'pending-no-final' };
      case 'silent-drops':
        await pending();
        return { kind: 'pending-no-final' };
      case 'ack-stores':
        this.values.set(key, behaviour.bytes);
        return { kind: 'acked' };
      case 'link-lost':
        if (behaviour.applied) this.values.set(key, bytes);
        this.closed = true;
        return { kind: 'link-lost' };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
