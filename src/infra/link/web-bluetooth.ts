import { readModuleDid, withModuleReads } from '@obdcraft/coding';
import {
  type BleDevice,
  type BleObservation,
  type BluetoothApi,
  ConnectError,
  clearPrecheck,
  makeContext,
  OBDCraftEngine,
  type Transport,
  TransportError,
  UdsExchangeError,
  WebBluetoothTransport,
} from '@obdcraft/obd-core';
import type { WireTrace } from '../../domain/coding/audit.ts';
import type {
  CarLink,
  CarReader,
  DidRead,
  DidWrite,
  IdentifyResult,
  ModuleAddress,
  ReadinessRead,
  SequenceSpec,
  VinFailure,
  WriteFrameMode,
  WriteOptions,
} from '../../domain/coding/types.ts';
import { recordDiag } from '../../domain/diagnostics.ts';
import { isPlausibleVin } from '../../domain/vin.ts';
import { type ChooserScope, chooserFor } from '../ble/web-chooser.ts';
import { rememberGrant } from '../ble/web-remembered.ts';
import { MAX_WRITE_MS, writeCodingDid } from './ble-writer.ts';
import { sequenceBudgetMs, writeCodingSequence } from './dataset-writer.ts';

export type ConnectFailure =
  | 'not-supported'
  | 'bluetooth-off'
  /** The browser or the user blocked Bluetooth for this site. */
  | 'permission-denied'
  | 'no-adapter'
  | 'car-silent'
  | 'adapter-failed';

/**
 * `message` is plain words for the owner; `technical` keeps what the browser or adapter actually said (for
 * diagnostics only, never shown).
 */
export class LinkConnectError extends Error {
  readonly code: ConnectFailure;
  readonly technical?: string;
  constructor(code: ConnectFailure, message: string, options?: ErrorOptions & { technical?: string }) {
    super(message, options);
    this.name = 'LinkConnectError';
    this.code = code;
    if (options?.technical) this.technical = options.technical;
  }
}

const hex = (bytes: readonly number[]): string =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const parseDid = (did: string): number => Number.parseInt(did, 16);

/** What the adapter said instead of a module answer, most telling first. */
const ADAPTER_STATUSES = ['UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR', 'BUS BUSY', 'NO DATA'] as const;
/** The adapter could not reach the car's bus at all (as opposed to a module that stayed silent). */
const BUS_UNREACHABLE: readonly string[] = ['UNABLE TO CONNECT', 'CAN ERROR', 'BUS ERROR'];

function adapterStatusOf(error: unknown): string | undefined {
  if (!(error instanceof UdsExchangeError)) return undefined;
  const said = new Set(error.replies.flatMap((r) => r.statuses as readonly string[]));
  return ADAPTER_STATUSES.find((s) => said.has(s));
}

/** Pure mapping from the transport's failures to what the domain understands. */
export function mapReadError(error: unknown, linkClosed: boolean): DidRead {
  if (linkClosed || (error instanceof TransportError && error.code === 'closed'))
    return { kind: 'link-lost' };
  if (error instanceof UdsExchangeError && error.nrc !== undefined) {
    return { kind: 'nrc', code: error.nrc.toString(16).toUpperCase().padStart(2, '0') };
  }
  const adapter = adapterStatusOf(error);
  // A pending or truncated answer is still the module answering: say which, and keep what arrived of it
  // (the service byte and the DID echo stripped).
  const detail = error instanceof UdsExchangeError ? error.detail : undefined;
  const partial =
    detail === 'truncated' && error instanceof UdsExchangeError && (error.partial?.length ?? 0) > 3
      ? hex(error.partial?.slice(3) ?? [])
      : undefined;
  return {
    kind: 'no-reply',
    ...(adapter ? { adapter } : {}),
    ...(detail ? { detail } : {}),
    ...(partial ? { partial } : {}),
  };
}

/** Why none of the VIN sources gave a VIN. */
export function vinFailure(answers: readonly DidRead[]): { why: VinFailure; adapter?: string } {
  const silent = answers.filter((a): a is Extract<DidRead, { kind: 'no-reply' }> => a.kind === 'no-reply');
  if (silent.length < answers.length || !answers.length) return { why: 'no-vin' };
  const unreachable = silent.find((a) => a.adapter && BUS_UNREACHABLE.includes(a.adapter));
  return silent.every((a) => a.adapter && BUS_UNREACHABLE.includes(a.adapter))
    ? { why: 'bus-silent', ...(unreachable?.adapter ? { adapter: unreachable.adapter } : {}) }
    : { why: 'no-answer' };
}

/**
 * Sends one read may take on a completed silence. The clone drops a request silently (~9 % even right after
 * a re-search, ~36 % again after a silent one) and the module never sees it, so asking again at once — every
 * read re-searches (withModuleReads) — is the cure; waiting first only costs time (BRIEF R2). Four sends
 * leave ~0.4 % unanswered. Everything else (NRC, a dead stream, a lost link) is final.
 */
const READ_SENDS = 4;

/**
 * The adapter completed the request cleanly but reported NO DATA — or UNABLE TO CONNECT, which is what the
 * same silence becomes during an ATSP0 re-search (live 11-01, W13#4: the pre-write read was not retried) —
 * or a multi-frame answer arrived short (the clone forwards 4 CFs per command; a longer DID needs the host's
 * own flow control, which the clone may drop like any send).
 */
function isCompletedEmpty(error: unknown): boolean {
  const last = error instanceof UdsExchangeError ? error.replies.at(-1) : undefined;
  if (!(error instanceof UdsExchangeError) || last?.status !== 'ok') return false;
  if (error.detail === 'truncated') return true;
  if (error.failure === 'timeout' && last.statuses.includes('NO DATA')) return true;
  return error.failure === 'adapter' && last.statuses.includes('UNABLE TO CONNECT');
}

/** Translate what the browser/engine throw while connecting into the few cases the UI explains. */
export function mapConnectError(error: unknown): LinkConnectError {
  if (error instanceof LinkConnectError) return error;
  if (error instanceof TransportError) {
    if (error.code === 'not_supported')
      return new LinkConnectError(
        'not-supported',
        'This browser cannot use Bluetooth. Try Chrome on Android or desktop.',
        { cause: error },
      );
    if (error.code === 'denied')
      return new LinkConnectError(
        'permission-denied',
        'Bluetooth is blocked for this site. Allow it, then try again.',
        { cause: error, technical: error.message },
      );
    if (error.code === 'cancelled')
      return new LinkConnectError('no-adapter', 'No adapter was chosen.', { cause: error });
    if (error.code === 'not_found') {
      const off = /off|powered|adapter not available/i.test(error.message);
      return new LinkConnectError(
        off ? 'bluetooth-off' : 'no-adapter',
        off ? 'Bluetooth is off. Turn it on, then try again.' : "We couldn't find your adapter.",
        { cause: error, technical: error.message },
      );
    }
  }
  if (error instanceof ConnectError) {
    if (error.reason === 'car_silent')
      return new LinkConnectError(
        'car-silent',
        'The car did not answer. Switch the ignition on (engine off).',
        { cause: error },
      );
    return new LinkConnectError('adapter-failed', "We couldn't connect to your adapter.", {
      cause: error,
      technical: error.message,
    });
  }
  return new LinkConnectError('adapter-failed', "We couldn't connect to your adapter.", {
    cause: error,
    ...(error instanceof Error ? { technical: error.message } : {}),
  });
}

/**
 * Everything the link needs from the adapter stack. `fromEngine` builds it over the real
 * ELM engine; tests can supply a fake or the engine running against the ELM emulator.
 */
export interface LinkIo {
  observeWire?(listener: (entry: WireTrace) => void): () => void;
  read(target: string, responseId: string, did: number): Promise<number[]>;
  withReads?<T>(module: ModuleAddress, work: (read: LinkIo['read']) => Promise<T>): Promise<T>;
  readiness?(): Promise<Omit<Extract<ReadinessRead, { kind: 'ok' }>, 'kind'>>;
  write?(module: ModuleAddress, did: string, bytes: string, options: WriteOptions): Promise<DidWrite>;
  /** Locks the adapter's send policy to read-only requests until the release is called. */
  lockReadOnly?(): () => void;
  /** Declared command rituals (dataset flashes). Absent → this I/O cannot run sequence recipes. */
  sequence?(module: ModuleAddress, spec: SequenceSpec, options: WriteOptions): Promise<DidWrite>;
  /** Must stop queued sends and detach listeners synchronously, then disconnect. */
  close(): Promise<void>;
}

export interface LinkOptions {
  /** Receives every adapter line from the first setup command on (the connection log). */
  onWire?: (entry: WireTrace) => void;
  /** Packet sizes, GATT completion times and disconnects; contains no payload or device identifier. */
  onBluetooth?: (entry: BleObservation) => void;
  /** Called once when the link closes, for whatever reason (disconnect, lost adapter, replaced link). */
  onClosed?: () => void;
  /** How writes hand their frames to the adapter, unless a write names its own (default `full`). */
  frameMode?: WriteFrameMode;
  /** False: writes skip the F199/F198 coding markers unless a write asks for them (default: stamped). */
  markers?: boolean;
  /**
   * What the browser's device chooser lists (default `adapters`: only devices that look like an adapter;
   * `all`: every nearby device, for clones that advertise neither a known name nor a known service).
   */
  chooser?: ChooserScope;
}

/**
 * What the adapter said about itself at connect (ATI, AT@1, STI/STDI, ATPPS): recorded in the connection log and
 * with the car details, so a session's firmware is known. No unit serial (AT@2) is kept.
 */
export interface AdapterSummary {
  cls: string;
  firmware: string;
  device: string;
  stn?: string;
  /** ATPPS answered (a PIC-style ELM); absent when not asked (STN). */
  pps?: 'answered' | 'refused';
  /** STPX framing is available (a confirmed STN chip). */
  stpx: boolean;
}

export function adapterSummary(engine: OBDCraftEngine): AdapterSummary | undefined {
  const p = engine.adapter.profile;
  if (!p) return undefined;
  const asked = p.cls !== 'stn' || !p.stn;
  return {
    cls: p.cls,
    firmware: p.firmware,
    device: p.raw.device,
    ...(p.stn ? { stn: `${p.stn.chip}${p.stn.device ? ` ${p.stn.device}` : ''}` } : {}),
    ...(asked ? { pps: p.ppSummary ? ('answered' as const) : ('refused' as const) } : {}),
    stpx: p.caps.stCommands,
  };
}

/** Where the VIN is served on the MQB-A0-IN platform: the instrument cluster, not the BCM (which answers NRC 31). */
const VIN_MODULE: ModuleAddress = { request: '714', response: '77E' };
/**
 * The body control module: asked first when no module is bound. On this car it answered while the rest of the bus
 * was still waking (native sessions 2026-10-22/23), and its answer is what the adapter's protocol search finds.
 */
const BCM_MODULE: ModuleAddress = { request: '70E', response: '778' };
/** Bounded wait for a disconnect; the link is unusable from the moment close() starts regardless. */
const CLOSE_WAIT_MS = 3000;

/** I/O over a connected engine: reads, readiness and the coding writer share its single command queue. */
export function engineIo(engine: OBDCraftEngine): LinkIo {
  return {
    read: (target, response, did) => readModuleDid(engine, target, response, did, 8000),
    withReads: (module, work) => withModuleReads(engine, module.request, module.response, work, 8000),
    async readiness() {
      const link = engine.link;
      const runner = engine.runner;
      if (!link || !runner) throw new TransportError('not connected', 'closed');
      // Stamped when collection STARTS: the evidence is at least this old, never younger than it is.
      const at = new Date().toISOString();
      await engine.stopLive();
      await link.apply({ target: 'functional', spaces: true, headers: true, adaptiveTiming: 1 });
      // The clone dropped the first 010C after ATSH7DF 93 % of the time (live W12#3): an ATSP0 makes it a
      // protocol search instead. The runner's NO DATA retries then follow the answer at once.
      if (link.nativeBind) await link.at('ATSP0');
      const ctx = makeContext(link, runner);
      for (const ecu of engine.ecus) ctx.ecus.set(ecu.id, ecu);
      const parked = await clearPrecheck(ctx);
      const volts = await link.at('ATRV');
      const voltage = Number.parseFloat(volts.reply.lines.join(' '));
      return {
        at,
        rpm: parked.rpm,
        speedKmh: parked.speed,
        voltage: volts.ok && Number.isFinite(voltage) ? voltage : null,
      };
    },
    lockReadOnly() {
      const link = engine.link;
      if (!link) throw new TransportError('not connected', 'closed');
      return link.policy.enterReadOnly();
    },
    async write(module, did, bytes, options) {
      const link = engine.link;
      if (!link) return { kind: 'link-lost' };
      return writeCodingDid(link, module, did, bytes, options);
    },
    async sequence(module, spec, options) {
      const link = engine.link;
      if (!link) return { kind: 'link-lost' };
      return writeCodingSequence(link, module, spec, options);
    },
    async close() {
      // Drop queued commands and wake any waiter NOW, before the (possibly slow) GATT teardown.
      engine.session?.dispose();
      await engine.disconnect();
    },
  };
}

/**
 * Live link over Web Bluetooth + ELM327.
 *
 * One physical connection at a time: connecting again first retires the previous link, and a
 * closed link is dead for good — its session is disposed (queued sends dropped, late bytes
 * ignored, waiters woken) before the GATT teardown, so an expired write can never share the
 * adapter with a new operation. "Check again" therefore always runs on a fresh connection.
 *
 * Writes go through the ported native sequence (ble-writer.ts) and declared rituals through the
 * dataset writer (dataset-writer.ts). Each call names its own module, so a multi-module (group)
 * recipe simply calls once per step with that step's address.
 */
export class WebBluetoothLink implements CarLink {
  readonly mode = 'live' as const;
  readonly canWrite: boolean;
  readonly maxWriteMs = MAX_WRITE_MS;
  readonly banner: string;
  /** The adapter's own identification at connect, when the engine read it. */
  adapter?: AdapterSummary;
  private closed = false;
  private readonly onClosed: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private readonly io: LinkIo;
  private readonly markers: boolean | undefined;
  private static current: WebBluetoothLink | undefined;

  constructor(io: LinkIo, options: LinkOptions = {}) {
    this.io = io;
    // A live link writes whenever its I/O can; there is no build- or qualification-level switch.
    this.canWrite = io.write !== undefined;
    this.onClosed = options.onClosed;
    this.markers = options.markers;
    this.banner = this.canWrite
      ? 'LIVE · connected to your car'
      : 'LIVE · connected to your car — this adapter link can only read';
  }

  /** Must be called from a user gesture (browser rule). Opens the device chooser. */
  static async connect(
    bluetooth: unknown = globalThis.navigator,
    options: LinkOptions = {},
  ): Promise<WebBluetoothLink> {
    if (!WebBluetoothTransport.available(bluetooth)) {
      throw new LinkConnectError(
        'not-supported',
        'This browser cannot use Bluetooth. Try Chrome on Android or desktop.',
      );
    }
    // One connect at a time: a second call waits for the first to finish, then retires its link, so two
    // overlapping calls can never both hold the adapter.
    const previous = WebBluetoothLink.connecting;
    let done = () => {};
    WebBluetoothLink.connecting = new Promise<void>((r) => {
      done = r;
    });
    try {
      await previous;
      return await WebBluetoothLink.open(bluetooth, options);
    } finally {
      done();
    }
  }

  private static connecting: Promise<void> | undefined;

  private static open(
    bluetooth: { bluetooth: BluetoothApi },
    options: LinkOptions,
    device?: BleDevice,
  ): Promise<WebBluetoothLink> {
    return WebBluetoothLink.openOver(
      () =>
        new WebBluetoothTransport(
          bluetooth.bluetooth,
          chooserFor(options.chooser ?? 'adapters'),
          options.onBluetooth,
          device,
        ),
      options,
    );
  }

  /**
   * The same connection over another byte pipe (the live kit's TCP bridge to the BLE adapter): identical
   * engine startup, wire log, writer and link. No browser path uses it.
   */
  static connectTransport(transport: Transport, options: LinkOptions = {}): Promise<WebBluetoothLink> {
    return WebBluetoothLink.openOver(() => transport, options);
  }

  private static async openOver(
    makeTransport: () => Transport,
    options: LinkOptions,
  ): Promise<WebBluetoothLink> {
    // Exclusive ownership of the adapter: the old link is fully retired before a new one opens.
    await WebBluetoothLink.retireCurrent();
    const listeners = new Set<(entry: WireTrace) => void>(options.onWire ? [options.onWire] : []);
    const engine = new OBDCraftEngine({
      // Select the protocol through a physical module request (ATSP0), as the native tool did.
      // There is no OBD-II engine search here. Matching this startup does not establish end-to-end parity.
      startup: 'diagnostic-can',
      onWire: (e) => {
        const entry: WireTrace = {
          at: new Date().toISOString(),
          elapsedMs: e.at,
          direction: e.dir,
          text: e.text,
        };
        for (const listener of listeners) {
          try {
            listener(entry);
          } catch {
            // Logging never interferes with the adapter.
          }
        }
      },
    });
    recordDiag('adapter', 'transport-open');
    try {
      await engine.connect(makeTransport());
    } catch (e) {
      const mapped = mapConnectError(e);
      recordDiag('adapter', 'init-failed', { code: mapped.code, message: mapped.message });
      throw mapped;
    }
    recordDiag('adapter', 'engine-ready');
    const summary = adapterSummary(engine);
    if (summary) recordDiag('adapter', 'identity', { ...summary });
    if (options.frameMode && engine.link) {
      engine.link.frameMode = options.frameMode;
      recordDiag('adapter', 'frame-mode', { mode: options.frameMode });
    }
    const transport = engine.transport;
    const granted = transport instanceof WebBluetoothTransport ? transport.reusableDevice : undefined;
    if (granted) {
      WebBluetoothLink.lastDevice = granted;
      rememberGrant(granted);
    }
    const link = WebBluetoothLink.adopt(engine, options);
    link.io.observeWire = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    return link;
  }

  /** The last BLE device the chooser granted — reusable for reconnects while this page lives. */
  private static lastDevice: BleDevice | undefined;

  /** Which adapter the chooser granted last (id and name only), for the picker to remember it. */
  static get grantedAdapter(): { id: string; name?: string } | undefined {
    const d = WebBluetoothLink.lastDevice;
    return d ? { id: d.id, ...(d.name ? { name: d.name } : {}) } : undefined;
  }

  /**
   * Opens a fresh link on the adapter the chooser already granted — no picker, no gesture. The
   * ELM stack is fully re-initialised and the new link does its own identity reads; used to
   * resume read-only scans and provably-unsent writes after a mid-session drop.
   */
  static async reconnect(
    bluetooth: unknown = globalThis.navigator,
    options: LinkOptions = {},
  ): Promise<WebBluetoothLink | undefined> {
    const device = WebBluetoothLink.lastDevice;
    if (!device || !WebBluetoothTransport.available(bluetooth)) return undefined;
    try {
      return await WebBluetoothLink.open(bluetooth, options, device);
    } catch {
      return undefined;
    }
  }

  /** Wraps a connected engine and makes it the one current link. */
  static adopt(engine: OBDCraftEngine, options: LinkOptions = {}): WebBluetoothLink {
    const link = new WebBluetoothLink(engineIo(engine), options);
    const summary = adapterSummary(engine);
    if (summary) link.adapter = summary;
    engine.on((e) => {
      if (e.type === 'disconnected') {
        recordDiag('link', 'disconnected');
        void link.close();
      }
    });
    WebBluetoothLink.current = link;
    return link;
  }

  /** Closes whatever link currently owns the adapter (bounded wait). */
  static async retireCurrent(): Promise<void> {
    const old = WebBluetoothLink.current;
    WebBluetoothLink.current = undefined;
    if (old) await old.close();
  }

  observeWire(listener: (entry: WireTrace) => void): () => void {
    return this.io.observeWire?.(listener) ?? (() => {});
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * The native coding tool's VIN read (ble-write-coding readVinEvidence): F190 from the bound module first, then —
   * when it refuses (the Kushaq BCM answers NRC 31) — from the instrument cluster, which serves the VIN on this
   * platform. Each module switch re-runs the adapter's protocol search (native binding). Padding bytes (00, AA)
   * are dropped before the VIN is checked, as the native tool did.
   */
  /**
   * The VIN cannot change while this BLE link stays open, so a proven identity is kept for the
   * life of the link: a cached answer is the same evidence a fresh read would produce, and this
   * car drops rapid repeats of one DID (live sessions 2026-10-28 — the verify re-read of F190
   * on 77E returned NO DATA ~1.5 s after the identical request answered). Only `ok` is kept —
   * `no-vin` may be a bus still waking (it retries), `link-lost` closes the link.
   */
  private identified?: Promise<IdentifyResult>;

  identify(bound: ModuleAddress = BCM_MODULE): Promise<IdentifyResult> {
    if (this.closed) return Promise.resolve({ kind: 'link-lost' });
    if (!this.identified) {
      this.identified = this.identifyOnce(bound).then((r) => {
        if (r.kind !== 'ok') this.identified = undefined;
        return r;
      });
    }
    return this.identified;
  }

  private async identifyOnce(bound: ModuleAddress): Promise<IdentifyResult> {
    try {
      // Uses the read primitive directly, not the scoped reader: the scoped identify serves the
      // `identified` cache, which is what this call is filling — routing through it would wait
      // on itself.
      return this.io.withReads
        ? await this.io.withReads(bound, (read) => this.identifyUsing(read, bound))
        : await this.identifyUsing(this.io.read.bind(this.io), bound);
    } catch {
      await this.close();
      return { kind: 'link-lost' };
    }
  }

  /** Scope is explicit: an unrelated read cannot accidentally join another operation's transaction. */
  async withReads<T>(module: ModuleAddress, work: (reader: CarReader) => Promise<T>): Promise<T> {
    if (this.closed) throw new TransportError('not connected', 'closed');
    const scoped = (read: LinkIo['read']): CarReader => ({
      // The scoped identify serves the same per-connection cache: verify must not repeat the F190
      // reads the connect-time identify already proved (live 2026-10-28 — the repeat went silent).
      identify: (bound = BCM_MODULE) => {
        if (this.closed) return Promise.resolve<IdentifyResult>({ kind: 'link-lost' });
        if (!this.identified) {
          this.identified = this.identifyUsing(read, bound).then((r) => {
            if (r.kind !== 'ok') this.identified = undefined;
            return r;
          });
        }
        return this.identified;
      },
      readDid: (target, did) => this.readUsing(read, target, did),
    });
    return this.io.withReads
      ? this.io.withReads(module, (read) => work(scoped(read)))
      : work(scoped(this.io.read.bind(this.io)));
  }

  private async identifyUsing(read: LinkIo['read'], bound: ModuleAddress): Promise<IdentifyResult> {
    if (this.closed) return { kind: 'link-lost' };
    const sources = bound.request === VIN_MODULE.request ? [VIN_MODULE] : [bound, VIN_MODULE];
    const answers: DidRead[] = [];
    for (const module of sources) {
      const r = await this.readUsing(read, module, 'F190');
      if (r.kind === 'link-lost') return r;
      if (r.kind === 'ok') {
        const vin = (r.bytes.match(/../g) ?? [])
          .map((b) => Number.parseInt(b, 16))
          .filter((b) => b !== 0x00 && b !== 0xaa)
          .map((b) => String.fromCharCode(b))
          .join('');
        if (isPlausibleVin(vin)) return { kind: 'ok', vin };
      }
      answers.push(r);
    }
    return { kind: 'no-vin', ...vinFailure(answers) };
  }

  async readDid(module: ModuleAddress, did: string): Promise<DidRead> {
    return this.readUsing(this.io.read.bind(this.io), module, did);
  }

  /** An I/O without a send policy of its own (a test fake) has no wire to lock: the domain's read-only guard still holds. */
  lockReadOnly(): () => void {
    return this.io.lockReadOnly ? this.io.lockReadOnly() : () => {};
  }

  private async readUsing(read: LinkIo['read'], module: ModuleAddress, did: string): Promise<DidRead> {
    for (let attempt = 0; attempt < READ_SENDS; attempt++) {
      if (this.closed) return { kind: 'link-lost' };
      try {
        const bytes = hex(await read(module.request, module.response, parseDid(did)));
        return this.closed ? { kind: 'link-lost' } : { kind: 'ok', bytes };
      } catch (e) {
        if (this.closed || attempt === READ_SENDS - 1 || !isCompletedEmpty(e))
          return mapReadError(e, this.closed);
      }
    }
    return { kind: 'link-lost' };
  }

  async readiness(): Promise<ReadinessRead> {
    if (this.closed || !this.io.readiness) return { kind: 'link-lost' };
    try {
      const r = await this.io.readiness();
      return this.closed ? { kind: 'link-lost' } : { kind: 'ok', ...r };
    } catch (e) {
      if (this.closed || (e instanceof TransportError && e.code === 'closed')) return { kind: 'link-lost' };
      // Couldn't read: report unknowns; the domain shows them as a warning.
      return { kind: 'ok', at: new Date().toISOString(), rpm: null, speedKmh: null, voltage: null };
    }
  }

  async writeDid(
    module: ModuleAddress,
    did: string,
    bytes: string,
    options: WriteOptions,
  ): Promise<DidWrite> {
    if (this.closed) return { kind: 'link-lost' };
    if (!this.io.write) return { kind: 'not-sent', detail: "This connection can't change settings." };
    return this.settled(await this.io.write(module, did, bytes, this.withMarkers(options)));
  }

  async sequence(module: ModuleAddress, spec: SequenceSpec, options: WriteOptions): Promise<DidWrite> {
    if (this.closed) return { kind: 'link-lost' };
    if (!this.io.sequence) return { kind: 'not-sent', detail: "This connection can't make this change." };
    return this.settled(await this.io.sequence(module, spec, this.withMarkers(options)));
  }

  private withMarkers(options: WriteOptions): WriteOptions {
    return this.markers === false && options.markers === undefined ? { ...options, markers: false } : options;
  }

  maxSequenceMs(spec: SequenceSpec): number {
    return sequenceBudgetMs(spec);
  }

  /**
   * A write that ended while the link was closing is lost — unless the module's answer already said what
   * happened (acknowledged, refused, or part of a download accepted). Its evidence (markers, steps, frames)
   * is kept either way.
   */
  private settled(r: DidWrite): DidWrite {
    if (!this.closed || r.kind === 'acked' || r.kind === 'nrc' || r.kind === 'partial') return r;
    return {
      kind: 'link-lost',
      ...(r.markers ? { markers: r.markers } : {}),
      ...(r.steps ? { steps: r.steps } : {}),
      ...(r.txFrames ? { txFrames: r.txFrames } : {}),
    };
  }

  /** Idempotent. The link is unusable from the first call; the teardown itself is bounded. */
  close(): Promise<void> {
    if (!this.closed) {
      try {
        this.onClosed?.();
      } catch {
        // A listener never stops the teardown.
      }
    }
    this.closed = true;
    if (WebBluetoothLink.current === this) WebBluetoothLink.current = undefined;
    this.closing ??= Promise.race([
      this.io.close().catch(() => {}),
      new Promise<void>((r) => setTimeout(r, CLOSE_WAIT_MS)),
    ]);
    return this.closing;
  }
}
