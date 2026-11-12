import { OBD, pidDefOrRaw } from '@obdcraft/definitions';
import type { Transport } from '../transport/types.ts';
import { realClock, type Clock } from '../util/clock.ts';
import { ElmSession, type WireEvent } from '../elm/session.ts';
import { ElmLink, type AdapterInfo } from '../elm/link.ts';
import { parseProtocol } from '../can/frames.ts';
import { RequestRunner } from '../obd/request.ts';
import { makeContext, type EcuInfo, type ObdContext, type Reading } from '../obd/context.ts';
import type { RequestRecord } from '../obd/records.ts';
import { discoverSupport, readMode01 } from '../obd/services/service01.ts';
import { readDtcs, type DtcListResult } from '../obd/services/dtc.ts';
import { readFreezeFrame, type FreezeFrameResult } from '../obd/services/service02.ts';
import { readMonitorTests, type Mode06Result } from '../obd/services/service06.ts';
import { readIdentity, type VehicleIdentity } from '../obd/services/service09.ts';
import { clearCodesGuarded, listOnboardTests, readO2Tests, type ClearResult, type O2TestResult, type OnboardTestsResult } from '../obd/services/guarded.ts';
import { SessionStore } from './store.ts';
import { computeCoverage, type CoverageSummary } from './coverage.ts';
import { LiveScheduler, type Tier } from './scheduler.ts';
import { ThroughputTuner, InMemoryTunerMemory, type TunerMemory } from './tuner.ts';
import { FIRST_QUERY_TIMEOUT_MS, identifyAdapter, shareableProfile, tunerSeedFor, type AdapterProfile } from '../adapters/identify.ts';

export type EngineState = 'idle' | 'connecting' | 'ready' | 'scanning' | 'live' | 'error' | 'closed';

export interface EngineOptions {
  clock?: Clock;
  tunerMemory?: TunerMemory;
  onWire?: (e: WireEvent) => void;
  /** Hard timeout per OBD request (ms). */
  requestTimeoutMs?: number;
  /**
   * When no ECU answers the OBD-II protocol search (`0100`): `fail` (default) refuses the connection;
   * `diagnostic-can` keeps the adapter and selects ISO 15765-4 CAN 11-bit 500 kbit (ATSP6), the bus the VAG
   * modules are coded on, as the native coding tool did — it never searched with 0100. Module reads then go
   * physically to each control unit; nothing is inferred about the engine (the coding readiness check still
   * requires the engine to answer before any write).
   */
  silentCar?: 'fail' | 'diagnostic-can';
  /**
   * How the connection reaches the car after the adapter is reset:
   *  - `obd-search` (default): ATSP0 and an OBD-II `0100` search, then ECU discovery (live data needs it);
   *  - `diagnostic-can`: exactly the native VAG coding tool's way — automatic protocol (ATSP0) and no OBD-II
   *    request at all. The first frame on the bus is a physical request to a control unit, which runs the protocol
   *    search; addressing another module searches again (native binding, see `ElmLink.nativeBind`). Readiness
   *    still asks the engine (010C/010D) before any write.
   */
  startup?: 'obd-search' | 'diagnostic-can';
}

export class ConnectError extends Error {
  readonly reason: 'adapter_silent' | 'car_silent' | 'protocol' | 'transport';

  constructor(message: string, reason: 'adapter_silent' | 'car_silent' | 'protocol' | 'transport', options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
    this.name = 'ConnectError';
  }
}

export interface ScanStep {
  id: 'adapter' | 'ecus' | 'identity' | 'status' | 'codes' | 'freeze' | 'data' | 'monitors' | 'tests' | 'o2' | 'summary';
  label: string;
  state: 'running' | 'done' | 'partial' | 'failed' | 'skipped';
  finding?: string;
  startedAt: number;
  endedAt?: number;
}

export interface FullScanResult {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  steps: ScanStep[];
  identity: VehicleIdentity | null;
  dtcs: { stored: DtcListResult | null; pending: DtcListResult | null; permanent: DtcListResult | null };
  freeze: FreezeFrameResult | null;
  monitors: Mode06Result | null;
  onboardTests: OnboardTestsResult | null;
  o2: O2TestResult | null;
  readings: Reading[];
  coverage: CoverageSummary;
}

/**
 * The OBD engine: owns the adapter session, discovery, the full scan, live
 * polling with the throughput tuner, and the request log. Framework-free.
 */
export class OBDCraftEngine {
  state: EngineState = 'idle';
  readonly clock: Clock;
  readonly store = new SessionStore();
  transport: Transport | null = null;
  session: ElmSession | null = null;
  link: ElmLink | null = null;
  runner: RequestRunner | null = null;
  ctx: ObdContext | null = null;
  tuner: ThroughputTuner | null = null;
  scheduler: LiveScheduler | null = null;
  adapter: Partial<AdapterInfo> = {};
  identity: VehicleIdentity | null = null;
  lastScan: FullScanResult | null = null;
  private liveRunning = false;
  private livePromise: Promise<void> | null = null;
  private paused = false;
  private listeners = new Set<(e: EngineEvent) => void>();
  private readonly tunerMemory: TunerMemory;
  liveStats = { requests: 0, values: 0, startedAt: 0 };

  private readonly opts: EngineOptions;

  constructor(opts: EngineOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
    this.tunerMemory = opts.tunerMemory ?? new InMemoryTunerMemory();
  }

  on(cb: (e: EngineEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.emit({ type: 'state', state: s });
  }

  get ecus(): EcuInfo[] {
    return this.ctx ? [...this.ctx.ecus.values()] : [];
  }

  private need(): ObdContext {
    if (!this.ctx || this.ctx.link.session.isClosed) throw new Error('not connected');
    return this.ctx;
  }

  /** Opens the transport, initialises the ELM327, finds the protocol and the ECUs. */
  async connect(transport: Transport): Promise<{ adapter: Partial<AdapterInfo>; ecus: EcuInfo[] }> {
    this.setState('connecting');
    this.transport = transport;
    try {
      if (!transport.isOpen) await transport.open();
    } catch (e) {
      this.setState('error');
      throw new ConnectError(`could not open the adapter: ${(e as Error).message}`, 'transport', { cause: e });
    }
    try {
      return await this.initialise(transport);
    } catch (e) {
      // Any failure after the transport opened releases it: a caller that never got a connected
      // engine has nothing to close, so nothing may stay open (a GATT link, notify listeners).
      this.session?.dispose();
      await transport.close().catch(() => {});
      this.setState('error'); // after close(), whose callback would otherwise leave 'closed'
      throw e;
    }
  }

  private async initialise(transport: Transport): Promise<{ adapter: Partial<AdapterInfo>; ecus: EcuInfo[] }> {
    this.session = new ElmSession(transport, { clock: this.clock, onWire: this.opts.onWire });
    this.link = new ElmLink(this.session);
    this.runner = new RequestRunner(this.link, {
      defaultTimeoutMs: this.opts.requestTimeoutMs ?? 2500,
      onRecord: (r) => {
        this.store.addRecord(r);
        this.emit({ type: 'record', record: r });
      },
    });
    this.ctx = makeContext(this.link, this.runner);
    transport.onClose((reason) => {
      this.liveRunning = false;
      this.setState('closed');
      this.emit({ type: 'disconnected', reason });
    });

    const link = this.link;
    const reset = await link.at('ATZ', 5000);
    if (!reset.ok) {
      const again = await link.at('ATI', 2000);
      if (!again.ok) {
        this.setState('error');
        throw new ConnectError('the adapter does not answer (no ELM327 prompt)', 'adapter_silent');
      }
    }
    for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH1', 'ATAT1']) await link.at(c);
    link.config = { spaces: true, headers: true, adaptiveTiming: 1, st: null, target: 'functional' };
    const profile = await identifyAdapter(link);
    this.adapter = { identity: profile.raw.identity, device: profile.raw.device, voltage: profile.raw.voltage, profile };
    // The link knows what it is talking to (an STN chip unlocks STPX framing on diagnostic channels).
    link.info = this.adapter;
    if (this.opts.startup === 'diagnostic-can') {
      // The native coding tool's start (ble-uds / ble-write-coding): automatic protocol and nothing sent to the car.
      // The adapter searches with the first physical request, so a control unit's own answer finds the bus, and
      // searches again whenever another module is addressed. No OBD-II 0100: on this car the engine was silent with
      // the ignition on while the BCM answered (native sessions 2026-10-22/23).
      const set = await link.at('ATSP0');
      if (!set.ok) {
        this.setState('error');
        throw new ConnectError('the adapter refused automatic protocol selection (ATSP0)', 'protocol');
      }
      // Until the first answer, the bus is assumed to be ISO 15765-4 CAN 11-bit 500 kbit (VAG diagnostics).
      link.protocol = parseProtocol('A6');
      link.nativeBind = true;
      link.searchTarget = null;
      this.adapter.protocol = link.protocol;
      this.setState('ready');
      this.emit({ type: 'connected', adapter: this.adapter, ecus: [] });
      return { adapter: this.adapter, ecus: [] };
    }
    await link.at('ATSP0');
    // trigger the protocol search, then read which protocol was found
    link.policy.check('0100', { family: link.protocol.family });
    const probe = await this.session.send('0100', FIRST_QUERY_TIMEOUT_MS);
    const silent = probe.statuses.includes('UNABLE TO CONNECT') || probe.statuses.includes('BUS INIT ERROR');
    const dpn = silent ? null : await link.at('ATDPN');
    link.protocol = parseProtocol(dpn?.reply.lines[0] ?? '0');
    if (silent || link.protocol.number === 0) {
      const kept = await this.onDiagnosticCan();
      if (kept) return kept;
    }
    if (silent) {
      this.setState('error');
      throw new ConnectError('the car does not answer: ignition off, or the car is not OBD-II compliant', 'car_silent');
    }
    if (link.protocol.number === 0) {
      this.setState('error');
      throw new ConnectError(
        probe.statuses.includes('NO DATA') ? 'the car does not answer (NO DATA): is the ignition on?' : 'no OBD protocol found',
        probe.statuses.includes('NO DATA') ? 'car_silent' : 'protocol',
      );
    }
    this.adapter.protocol = link.protocol;
    const disc = await discoverSupport(this.ctx);
    if (disc.ecus.length === 0) {
      const kept = await this.onDiagnosticCan();
      if (kept) return kept;
      this.setState('error');
      throw new ConnectError('the car answered the protocol search but no ECU listed its supported data', 'car_silent');
    }
    this.tuner = new ThroughputTuner(link, {
      memory: this.tunerMemory,
      seed: tunerSeedFor(profile),
      allowPhysical: () => {
        const sched = this.scheduler;
        const engine = this.ecus.find((e) => e.role === 'engine');
        return !!sched && !!engine && engine.requestId !== null && sched.stats().every((s) => s.ecu === engine.id);
      },
    });
    this.tuner.physicalTarget = () => this.ecus.find((e) => e.role === 'engine')?.requestId ?? null;
    this.setState('ready');
    this.emit({ type: 'connected', adapter: this.adapter, ecus: disc.ecus });
    return { adapter: this.adapter, ecus: disc.ecus };
  }

  /**
   * No ECU answered the OBD-II search. With `silentCar: 'diagnostic-can'` the adapter stays on ISO 15765-4 CAN 11-bit
   * 500 kbit (ATSP6), the bus the VAG modules are coded on, as the native coding tool did; otherwise null.
   */
  private async onDiagnosticCan(): Promise<{ adapter: Partial<AdapterInfo>; ecus: EcuInfo[] } | null> {
    const link = this.link;
    if (this.opts.silentCar !== 'diagnostic-can' || !link) return null;
    const set = await link.at('ATSP6');
    if (!set.ok) return null;
    link.protocol = parseProtocol('6');
    this.adapter.protocol = link.protocol;
    this.setState('ready');
    this.emit({ type: 'connected', adapter: this.adapter, ecus: [] });
    return { adapter: this.adapter, ecus: [] };
  }

  /** Key for remembering tuned settings: a different adapter is tuned from scratch. */
  adapterKey(): string {
    return `${this.transport?.kind}:${this.transport?.id}:${this.adapter.identity}:${this.adapter.protocol?.number}`;
  }

  /** Reads everything generic OBD-II offers, step by step. Read-only. */
  async fullScan(onStep?: (s: ScanStep, all: ScanStep[]) => void): Promise<FullScanResult> {
    const ctx = this.need();
    const wasLive = this.liveRunning;
    if (wasLive) await this.stopLive();
    this.setState('scanning');
    await this.ensureBaselineAdapter();
    const startedAt = this.clock.now();
    const steps: ScanStep[] = [];
    const step = async <T>(id: ScanStep['id'], label: string, fn: () => Promise<{ value: T; finding: string; state?: ScanStep['state'] }>): Promise<T | null> => {
      this.need();
      const s: ScanStep = { id, label, state: 'running', startedAt: this.clock.now() };
      steps.push(s);
      onStep?.(s, steps);
      this.emit({ type: 'scan_step', step: s });
      try {
        const r = await fn();
        this.need();
        s.state = r.state ?? 'done';
        s.finding = r.finding;
        s.endedAt = this.clock.now();
        onStep?.(s, steps);
        this.emit({ type: 'scan_step', step: s });
        return r.value;
      } catch (e) {
        if (ctx.link.session.isClosed) throw e;
        s.state = 'failed';
        s.finding = (e as Error).message;
        s.endedAt = this.clock.now();
        onStep?.(s, steps);
        this.emit({ type: 'scan_step', step: s });
        return null;
      }
    };
    const proto = this.link!.protocol;
    await step('adapter', 'Adapter and protocol', async () => ({
      value: null,
      finding: `${this.adapter.identity ?? 'adapter'}; ${proto.name}; battery ${this.adapter.voltage || 'n/a'}`,
    }));
    await step('ecus', 'Control units', async () => ({
      value: null,
      finding: this.ecus.map((e) => `${e.id} (${e.role}, ${[...e.pids].filter((p) => p % 0x20 !== 0).length} data items)`).join(', '),
    }));
    const identity = await step('identity', 'Vehicle identity (mode 09)', async () => {
      const id = await readIdentity(ctx);
      this.identity = id;
      const ok = id.items.filter((i) => i.status === 'ok').length;
      return {
        value: id,
        finding: `${id.vin ? 'VIN read' : 'VIN not available'}; ${ok} of ${id.items.length} items read`,
        state: id.items.some((i) => i.status !== 'ok') ? 'partial' : 'done',
      };
    });
    const readings: Reading[] = [];
    await step('status', 'Check-engine light and self-check status', async () => {
      const res = await readMode01(ctx, [0x01], { retryNoData: true });
      const res41 = this.ecus.some((e) => e.pids.has(0x41)) ? await readMode01(ctx, [0x41], { retryNoData: true }) : null;
      readings.push(...res.readings, ...(res41?.readings ?? []));
      this.store.addReadings([...res.readings, ...(res41?.readings ?? [])]);
      const mil = res.readings.find((r) => r.key === 'monitor_status_mil' && r.ecu === this.engineId());
      const cnt = res.readings.find((r) => r.key === 'monitor_status_dtc_count' && r.ecu === this.engineId());
      return { value: null, finding: mil ? `check-engine light ${mil.value ? 'ON' : 'off'}; ${cnt?.value ?? '?'} confirmed code(s) reported` : 'status not available' };
    });
    const stored = await step('codes', 'Fault codes (modes 03, 07, 0A)', async () => {
      const s = await readDtcs(ctx, 'stored');
      const p = await readDtcs(ctx, 'pending');
      const a = await readDtcs(ctx, 'permanent');
      const n = (r: DtcListResult) => r.perEcu.reduce((k, e) => k + e.codes.length, 0);
      const desc = (r: DtcListResult, label: string) => (r.state === 'codes' || r.state === 'none' ? `${n(r)} ${label}` : `${label}: ${r.state}`);
      return { value: { stored: s, pending: p, permanent: a }, finding: [desc(s, 'stored'), desc(p, 'pending'), desc(a, 'permanent')].join('; ') };
    });
    const freeze = await step('freeze', 'Freeze frame (mode 02)', async () => {
      const f = await readFreezeFrame(ctx);
      const storedFrames = f.perEcu.filter((p) => p.state === 'stored');
      return {
        value: f,
        finding: storedFrames.length
          ? storedFrames.map((p) => `${p.ecu}: stored by ${p.dtc?.code}`).join('; ')
          : f.perEcu.every((p) => p.state === 'unavailable')
            ? 'not available'
            : 'no freeze frame stored',
      };
    });
    await step('data', 'All supported live data (mode 01)', async () => {
      let n = 0;
      let failed = 0;
      for (const e of this.ecus) {
        for (const pid of [...e.pids].sort((a, b) => a - b)) {
          this.need();
          if (pid % 0x20 === 0 || pid === 0x01 || pid === 0x41 || !pidDefOrRaw(pid)) continue;
          const res = await readMode01(ctx, [pid], { expectEcus: [e.id], retryNoData: true, maxAttempts: 3 });
          const mine = res.readings.filter((r) => r.ecu === e.id);
          readings.push(...res.readings);
          this.store.addReadings(res.readings);
          if (mine.length) n++;
          else failed++;
        }
      }
      return { value: null, finding: `${n} items decoded${failed ? `, ${failed} not decoded` : ''}`, state: failed ? 'partial' : 'done' };
    });
    const monitors = await step('monitors', 'Self-check results (mode 06)', async () => {
      const m = await readMonitorTests(ctx);
      if (!m.applicable) return { value: m, finding: 'not used on this protocol', state: 'skipped' };
      const tests = m.perEcu.flatMap((e) => e.tests);
      const fails = tests.filter((t) => !t.passed).length;
      const failedMids = m.perEcu.flatMap((e) => e.failedMids).length;
      return {
        value: m,
        finding: `${tests.length} test results from ${m.perEcu.reduce((k, e) => k + e.mids.length, 0)} monitors; ${fails} outside limits${failedMids ? `; ${failedMids} monitor(s) unreadable` : ''}`,
        state: failedMids ? 'partial' : 'done',
      };
    });
    const tests = await step('tests', 'On-board tests available (mode 08, list only)', async () => {
      const t = await listOnboardTests(ctx);
      return { value: t, finding: t.state === 'listed' ? `${t.perEcu.reduce((k, e) => k + e.tids.length, 0)} tests available (not run)` : 'none offered' };
    });
    const o2 = await step('o2', 'Oxygen sensor tests (mode 05)', async () => {
      const r = await readO2Tests(ctx);
      return { value: r, finding: r.applicable ? `${r.tests.length} results` : r.reason ?? 'not applicable', state: r.applicable ? 'done' : 'skipped' };
    });
    const coverage = computeCoverage(this.ecus, this.store);
    await step('summary', 'Summary', async () => ({
      value: null,
      finding: `${coverage.decoded} of ${coverage.advertised} advertised data items decoded`,
    }));
    const endedAt = this.clock.now();
    const result: FullScanResult = {
      startedAt, endedAt, durationMs: endedAt - startedAt, steps, identity,
      dtcs: { stored: stored?.stored ?? null, pending: stored?.pending ?? null, permanent: stored?.permanent ?? null },
      freeze, monitors, onboardTests: tests, o2, readings, coverage,
    };
    this.lastScan = result;
    this.setState('ready');
    this.emit({ type: 'scan_done', result });
    if (wasLive) await this.startLive();
    return result;
  }

  engineId(): string | undefined {
    return this.ecus.find((e) => e.role === 'engine')?.id;
  }

  /** Scans use the plain, most compatible settings. */
  private async ensureBaselineAdapter(): Promise<void> {
    if (!this.link) return;
    await this.link.apply({ target: 'functional', spaces: true, adaptiveTiming: 1 });
  }

  /** Live polling. No fixed rate cap: the tuner pushes as hard as the adapter allows. */
  async startLive(opts: { pids?: number[]; tiers?: Record<number, Tier> } = {}): Promise<void> {
    const ctx = this.need();
    if (this.liveRunning) return;
    const all = new Set<number>();
    for (const e of this.ecus) for (const p of e.pids) if (p % 0x20 !== 0) all.add(p);
    const pids = opts.pids ?? [...all].sort((a, b) => a - b);
    this.scheduler = new LiveScheduler(ctx.ecus, () => this.clock.now());
    this.scheduler.setPids(pids, opts.tiers);
    this.tuner!.start(this.adapterKey());
    this.liveRunning = true;
    this.liveStats = { requests: 0, values: 0, startedAt: this.clock.now() };
    this.setState('live');
    this.livePromise = this.liveLoop();
  }

  async stopLive(): Promise<void> {
    this.liveRunning = false;
    await this.livePromise;
    this.livePromise = null;
    if (this.state === 'live') this.setState('ready');
  }

  /** The page went to the background or the screen turned off: stop sending until visible again. */
  setPaused(p: boolean): void {
    this.paused = p;
    this.emit({ type: 'paused', paused: p });
  }

  private async liveLoop(): Promise<void> {
    const ctx = this.need();
    const tuner = this.tuner!;
    const sched = this.scheduler!;
    while (this.liveRunning) {
      if (this.paused) {
        await this.clock.sleep(250);
        continue;
      }
      await tuner.beforeRequest();
      const cfg = tuner.config;
      const engine = this.engineId();
      const batch = sched.next({ maxPids: cfg.maxPids, maxReplyBytes: cfg.maxReplyBytes }, cfg.physical ? engine : undefined);
      if (!batch) {
        await this.clock.sleep(100);
        continue;
      }
      const expect = cfg.physical ? [batch.ecu] : this.ecus.filter((e) => batch.pids.some((p) => e.pids.has(p))).map((e) => e.id);
      const t0 = this.clock.now();
      const res = await readMode01(ctx, batch.pids, {
        purpose: 'live', expectEcus: expect, maxAttempts: 1, timeoutMs: 1500,
        ...(cfg.responseCount ? { responseCount: expect.length } : {}),
      });
      const dt = this.clock.now() - t0;
      this.store.addReadings(res.readings);
      if (res.readings.length) this.emit({ type: 'readings', readings: res.readings });
      let good = 0;
      for (const pid of batch.pids) {
        const ok = res.decoded.some((d) => d.ecu === batch.ecu && d.pid === pid && d.decoded.status === 'decoded');
        if (ok) good++;
        sched.report(batch.ecu, pid, ok);
      }
      if (batch.pids.length > 1 && res.parseFailed.includes(batch.ecu)) tuner.multiPidFailed();
      tuner.observe({ durationMs: dt, expected: batch.pids.length, good });
      this.liveStats.requests++;
      this.liveStats.values += good;
      if (!this.transport?.isOpen) break;
    }
  }

  liveRate(): { requestsPerSecond: number; valuesPerSecond: number } {
    const dt = (this.clock.now() - this.liveStats.startedAt) / 1000;
    return { requestsPerSecond: dt > 0 ? this.liveStats.requests / dt : 0, valuesPerSecond: dt > 0 ? this.liveStats.values / dt : 0 };
  }

  coverage(): CoverageSummary {
    return computeCoverage(this.ecus, this.store);
  }

  async clearCodes(typedConfirmation: string, acknowledgedWarning: boolean): Promise<ClearResult> {
    const ctx = this.need();
    if (this.liveRunning) await this.stopLive();
    await this.ensureBaselineAdapter();
    return clearCodesGuarded(ctx, typedConfirmation, acknowledgedWarning);
  }

  async disconnect(): Promise<void> {
    await this.stopLive();
    this.session?.dispose();
    await this.transport?.close();
    this.setState('closed');
  }

  /** Session export. The VIN is redacted unless asked for; raw bytes only when asked for. */
  exportSession(opts: { includeVin?: boolean; includeRaw?: boolean } = {}): SessionExport {
    const redact = (s: string | null | undefined) => (s && !opts.includeVin ? redactVin(s) : s ?? null);
    const records = this.store.records.map((r) => (opts.includeRaw ? r : stripRaw(r)));
    const vin = this.identity?.vin ?? null;
    return {
      schema: 'obdcraft.session/1',
      definitions: OBD.version,
      exportedAt: new Date().toISOString(),
      // the unit's own identifier (AT@2) stays on the device
      adapter: this.adapter.profile ? { ...this.adapter, profile: shareableProfile(this.adapter.profile) as AdapterProfile } : this.adapter,
      ecus: this.ecus.map((e) => ({
        id: e.id, role: e.role, name: e.name ?? null,
        pids: [...e.pids].sort((a, b) => a - b).map((p) => p.toString(16).toUpperCase().padStart(2, '0')),
        freezePids: [...e.freezePids].map((p) => p.toString(16).toUpperCase().padStart(2, '0')),
        mids: [...e.mids].map((p) => p.toString(16).toUpperCase().padStart(2, '0')),
        infoPids: [...e.infoPids].map((p) => p.toString(16).toUpperCase().padStart(2, '0')),
      })),
      vin: redact(vin),
      vinRedacted: !!vin && !opts.includeVin,
      identity: this.identity
        ? this.identity.items.map((i) => ({ ...i, text: i.pid === 0x02 ? redact(i.text) : i.text, raw: i.pid === 0x02 && !opts.includeVin ? '' : i.raw }))
        : null,
      scan: this.lastScan
        ? { durationMs: this.lastScan.durationMs, steps: this.lastScan.steps, dtcs: this.lastScan.dtcs, freeze: this.lastScan.freeze, monitors: this.lastScan.monitors, onboardTests: this.lastScan.onboardTests }
        : null,
      coverage: this.coverage(),
      statusCounts: this.store.statusCounts(),
      latest: [...this.store.latest.values()],
      tuner: this.tuner ? { summary: this.tuner.summary(), events: this.tuner.events } : null,
      liveRate: this.liveRate(),
      records: opts.includeVin ? records : records.map(redactRecordVin),
      rawIncluded: !!opts.includeRaw,
    };
  }
}

export interface SessionExport {
  schema: string;
  definitions: string;
  exportedAt: string;
  adapter: Partial<AdapterInfo>;
  ecus: { id: string; role: string; name: string | null; pids: string[]; freezePids: string[]; mids: string[]; infoPids: string[] }[];
  vin: string | null;
  vinRedacted: boolean;
  identity: unknown;
  scan: unknown;
  coverage: CoverageSummary;
  statusCounts: Record<string, number>;
  latest: Reading[];
  tuner: unknown;
  liveRate: { requestsPerSecond: number; valuesPerSecond: number };
  records: RequestRecord[];
  rawIncluded: boolean;
}

/** Keeps only the manufacturer code (first 3 characters, not personal); hides the rest. */
export function redactVin(vin: string): string {
  return vin.length > 3 ? `${vin.slice(0, 3)}${'*'.repeat(vin.length - 3)}` : '*'.repeat(vin.length);
}

function stripRaw(r: RequestRecord): RequestRecord {
  return { ...r, attempts: r.attempts.map((a) => ({ ...a, rxRaw: '', txHex: '', staleBefore: undefined })) };
}

function redactRecordVin(r: RequestRecord): RequestRecord {
  if (!(r.service === 0x09 && r.params[0] === 0x02)) return r;
  return {
    ...r,
    attempts: r.attempts.map((a) => ({ ...a, rxRaw: '[VIN redacted]', lines: ['[VIN redacted]'] })),
    ecus: Object.fromEntries(Object.entries(r.ecus).map(([k, v]) => [k, { ...v, payload: [] }])),
  };
}

export type EngineEvent =
  | { type: 'state'; state: EngineState }
  | { type: 'connected'; adapter: Partial<AdapterInfo>; ecus: EcuInfo[] }
  | { type: 'disconnected'; reason: string }
  | { type: 'record'; record: RequestRecord }
  | { type: 'readings'; readings: Reading[] }
  | { type: 'scan_step'; step: ScanStep }
  | { type: 'scan_done'; result: FullScanResult }
  | { type: 'paused'; paused: boolean };
