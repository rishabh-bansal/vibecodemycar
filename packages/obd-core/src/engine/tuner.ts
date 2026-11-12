import type { AdapterConfig, ElmLink } from '../elm/link.ts';

/**
 * Everything the tuner may change. There is no fixed request-rate cap: the
 * tuner keeps whatever setting delivers the most correct values per second on
 * this adapter and this car, and backs off when quality drops.
 */
export interface TuneConfig {
  /** Append the ELM response-count digit, so the adapter returns as soon as the expected replies arrived. */
  responseCount: boolean;
  /** PIDs per service 01 request (1 = no multi-PID). */
  maxPids: number;
  /** Largest reply payload: 7 keeps every reply in one CAN frame (safer on adapters that lose frames). */
  maxReplyBytes: number;
  /** ATS0: no spaces, about a third fewer bytes over Bluetooth. */
  spaces: boolean;
  /** ATAT0/1/2. */
  adaptiveTiming: 0 | 1 | 2;
  /** Address the engine ECU directly (ATSH 7E0 + ATCRA 7E8): only it answers, no waiting for others. */
  physical: boolean;
}

export const BASELINE: TuneConfig = { responseCount: false, maxPids: 1, maxReplyBytes: 7, spaces: true, adaptiveTiming: 1, physical: false };

export interface Experiment {
  id: string;
  label: string;
  change: Partial<TuneConfig>;
  /** Whether it is worth trying given the current config. */
  applicable?: (c: TuneConfig) => boolean;
}

export const LADDER: Experiment[] = [
  { id: 'count', label: 'response-count digit', change: { responseCount: true } },
  { id: 'ats0', label: 'compact replies (ATS0)', change: { spaces: false } },
  { id: 'physical', label: 'address the engine ECU directly', change: { physical: true } },
  { id: 'multi2', label: '2 PIDs per request', change: { maxPids: 2, maxReplyBytes: 7 }, applicable: (c) => c.maxPids < 2 },
  { id: 'multi3', label: '3 PIDs per request', change: { maxPids: 3, maxReplyBytes: 7 }, applicable: (c) => c.maxPids < 3 },
  { id: 'multi6', label: 'up to 6 PIDs per request (multi-frame replies)', change: { maxPids: 6, maxReplyBytes: 4095 }, applicable: (c) => c.maxPids < 6 },
  { id: 'at2', label: 'aggressive adaptive timing (ATAT2)', change: { adaptiveTiming: 2 } },
];

export interface TunerSample {
  durationMs: number;
  /** Values that should have arrived (PIDs requested from the target ECU). */
  expected: number;
  /** Values that arrived and decoded. */
  good: number;
}

export interface TunerEvent {
  at: number;
  kind: 'start' | 'measure' | 'accept' | 'reject' | 'backoff' | 'reprobe' | 'apply_failed' | 'restore';
  experiment?: string;
  rate?: number;
  quality?: number;
  baselineRate?: number;
  config: TuneConfig;
  note?: string;
}

export interface TunerMemory {
  load(key: string): TuneConfig | null;
  save(key: string, cfg: TuneConfig): void;
}

export class InMemoryTunerMemory implements TunerMemory {
  private m = new Map<string, TuneConfig>();
  load(key: string) {
    return this.m.get(key) ?? null;
  }
  save(key: string, cfg: TuneConfig) {
    this.m.set(key, { ...cfg });
  }
}

export interface TunerOptions {
  /** Requests per measurement window. */
  windowRequests?: number;
  /** Minimum window duration (ms). */
  windowMs?: number;
  /** Relative gain needed to keep a change. */
  minGain?: number;
  /** Allowed quality loss when accepting a change. */
  qualitySlack?: number;
  /** Quality drop (vs accepted) that triggers a back-off in steady state. */
  backoffDrop?: number;
  /** Steady-state re-probe interval for rejected experiments (ms). */
  reprobeMs?: number;
  memory?: TunerMemory;
  /** Whether physical addressing is allowed (all live PIDs on one ECU). */
  allowPhysical?: () => boolean;
  /** Where to start when nothing is remembered for the adapter (e.g. confirmed STN hardware). It is re-measured first. */
  seed?: TuneConfig | null;
}

interface Window {
  start: number;
  requests: number;
  ms: number;
  expected: number;
  good: number;
}

/**
 * Online throughput maximiser. It measures correct values per second on real
 * live traffic, tries one change at a time from a ladder, keeps it only if it
 * is faster without losing quality, and keeps watching: if quality later drops
 * (another tester wakes up, the adapter struggles) it steps back and re-probes
 * later. Results are remembered per adapter, so a different adapter is tuned
 * from scratch.
 */
export class ThroughputTuner {
  config: TuneConfig = { ...BASELINE };
  readonly events: TunerEvent[] = [];
  private accepted: { exp: Experiment; prev: TuneConfig; quality: number }[] = [];
  private rejected = new Map<string, number>();
  private trying: { exp: Experiment; prev: TuneConfig } | null = null;
  private best = { rate: 0, quality: 1 };
  private win: Window;
  private steady: Window;
  private phase: 'baseline' | 'experiment' | 'steady' = 'baseline';
  private lastReprobe = 0;
  private readonly o: Required<Omit<TunerOptions, 'memory' | 'allowPhysical' | 'seed'>> & Pick<TunerOptions, 'memory' | 'allowPhysical' | 'seed'>;
  private pendingApply: TuneConfig | null = null;
  private restored = false;
  adapterKey = 'unknown';

  private readonly link: ElmLink;

  constructor(link: ElmLink, opts: TunerOptions = {}) {
    this.link = link;
    this.o = {
      windowRequests: 14, windowMs: 2500, minGain: 0.04, qualitySlack: 0.02, backoffDrop: 0.12, reprobeMs: 120_000,
      ...opts,
    };
    this.win = this.newWindow();
    this.steady = this.newWindow();
  }

  private now(): number {
    return this.link.clock.now();
  }

  private newWindow(): Window {
    return { start: this.now(), requests: 0, ms: 0, expected: 0, good: 0 };
  }

  private log(e: Omit<TunerEvent, 'at' | 'config'>): void {
    this.events.push({ at: this.now(), config: { ...this.config }, ...e });
    if (this.events.length > 500) this.events.shift();
  }

  /** Starts tuning for an adapter; reuses a remembered config but re-verifies it first. */
  start(adapterKey: string): void {
    this.adapterKey = adapterKey;
    const saved = this.o.memory?.load(adapterKey);
    const seed = saved ? null : this.o.seed ?? null;
    this.accepted = [];
    this.rejected.clear();
    this.trying = null;
    this.phase = 'baseline';
    this.restored = !!saved || !!seed;
    if (saved || seed) {
      const start = { ...(saved ?? seed!) };
      // K-line and J1850 allow one PID per request (SAE J1979): never start multi-PID there
      if (this.link.protocol.family === 'legacy') { start.maxPids = 1; start.maxReplyBytes = 7; }
      this.pendingApply = start;
      this.log({ kind: 'restore', note: saved ? 'remembered settings for this adapter; re-verifying' : 'starting point for this adapter class; re-verifying' });
    } else {
      this.pendingApply = { ...BASELINE };
      this.log({ kind: 'start' });
    }
    this.win = this.newWindow();
  }

  /** Applies pending adapter settings. Call before each live request. */
  async beforeRequest(): Promise<void> {
    if (!this.pendingApply) return;
    const want = this.pendingApply;
    this.pendingApply = null;
    const adapterChange: Partial<AdapterConfig> = { spaces: want.spaces, adaptiveTiming: want.adaptiveTiming };
    const engine = want.physical ? this.physicalTarget?.() : null;
    adapterChange.target = engine ?? 'functional';
    const { failed } = await this.link.apply(adapterChange);
    if (failed.length) {
      // the adapter refused a setting: keep what it accepted
      this.config = {
        ...want,
        spaces: this.link.config.spaces,
        adaptiveTiming: this.link.config.adaptiveTiming,
        physical: this.link.config.target !== 'functional',
      };
      this.log({ kind: 'apply_failed', note: failed.join(', ') });
      if (this.trying) {
        this.rejected.set(this.trying.exp.id, this.now());
        this.trying = null;
        this.phase = 'steady';
      }
    } else {
      this.config = { ...want, physical: want.physical && !!engine };
    }
    this.win = this.newWindow();
  }

  /** Engine ECU physical request id (e.g. 7E0), supplied by the engine. */
  physicalTarget?: () => string | null;

  /** A multi-PID reply could not be parsed: treat like a failed experiment immediately. */
  multiPidFailed(): void {
    if (this.trying && this.trying.exp.change.maxPids !== undefined) this.finishExperiment(0, 0, 'multi-PID reply not understood');
    else if (this.config.maxPids > 1) {
      this.log({ kind: 'backoff', note: 'multi-PID reply not understood' });
      this.config = { ...this.config, maxPids: 1, maxReplyBytes: 7 };
      this.pendingApply = { ...this.config };
    }
  }

  observe(s: TunerSample): void {
    // A request made while new settings were decided but not yet applied ran under the OLD settings:
    // it must not count toward judging the new ones (e.g. multiPidFailed() → next experiment → observe()).
    if (this.pendingApply) return;
    for (const w of [this.win, this.steady]) {
      w.requests++;
      w.ms += s.durationMs;
      w.expected += s.expected;
      w.good += s.good;
    }
    const elapsed = this.now() - this.win.start;
    if (this.win.requests < this.o.windowRequests || elapsed < this.o.windowMs) {
      if (this.phase === 'steady') this.checkSteady();
      return;
    }
    const rate = (this.win.good / Math.max(1, elapsed)) * 1000;
    const quality = this.win.expected ? this.win.good / this.win.expected : 0;
    if (this.phase === 'baseline') {
      if (this.restored && quality < 0.8) {
        // remembered settings do not work any more (different car, firmware, conditions): start over
        this.restored = false;
        this.config = { ...BASELINE };
        this.pendingApply = { ...BASELINE };
        this.log({ kind: 'backoff', quality, note: 'remembered settings performed poorly; re-tuning from the baseline' });
        return;
      }
      this.restored = false;
      this.best = { rate, quality };
      this.log({ kind: 'measure', rate, quality, note: 'baseline' });
      this.phase = 'steady';
      this.nextExperiment();
    } else if (this.phase === 'experiment') {
      this.finishExperiment(rate, quality);
    } else {
      this.win = this.newWindow();
    }
  }

  private finishExperiment(rate: number, quality: number, note?: string): void {
    const t = this.trying;
    if (!t) return;
    const gain = this.best.rate > 0 ? rate / this.best.rate - 1 : rate > 0 ? 1 : 0;
    const ok = !note && gain >= this.o.minGain && quality >= this.best.quality - this.o.qualitySlack;
    this.trying = null;
    this.phase = 'steady';
    if (ok) {
      this.accepted.push({ exp: t.exp, prev: t.prev, quality });
      this.log({ kind: 'accept', experiment: t.exp.id, rate, quality, baselineRate: this.best.rate });
      this.best = { rate, quality };
      this.o.memory?.save(this.adapterKey, this.config);
    } else {
      this.rejected.set(t.exp.id, this.now());
      this.log({ kind: 'reject', experiment: t.exp.id, rate, quality, baselineRate: this.best.rate, ...(note ? { note } : {}) });
      // back to the last accepted settings; the adapter is updated on the next request
      this.config = { ...t.prev };
      this.pendingApply = { ...t.prev };
    }
    this.nextExperiment();
  }

  private nextExperiment(): boolean {
    for (const exp of LADDER) {
      if (this.accepted.some((a) => a.exp.id === exp.id)) continue;
      if (this.rejected.has(exp.id)) continue;
      if (exp.applicable && !exp.applicable(this.config)) continue;
      if (exp.id === 'physical' && !(this.o.allowPhysical?.() ?? false)) continue;
      // K-line and J1850 allow one PID per request (SAE J1979)
      if ((exp.change.maxPids ?? 1) > 1 && this.link.protocol.family === 'legacy') continue;
      const next = { ...this.config, ...exp.change };
      if (JSON.stringify(next) === JSON.stringify(this.config)) continue;
      this.trying = { exp, prev: { ...this.config } };
      this.pendingApply = next;
      this.phase = 'experiment';
      this.win = this.newWindow(); // an experiment is measured on its own requests only
      return true;
    }
    this.steady = this.newWindow();
    this.lastReprobe = this.now();
    return false;
  }

  /** In steady state: back off when quality falls, re-probe rejected experiments now and then. */
  private checkSteady(): void {
    const s = this.steady;
    if (s.requests >= 30) {
      const q = s.expected ? s.good / s.expected : 1;
      const top = this.accepted[this.accepted.length - 1];
      if (top && q < top.quality - this.o.backoffDrop) {
        this.accepted.pop();
        this.rejected.set(top.exp.id, this.now());
        this.log({ kind: 'backoff', experiment: top.exp.id, quality: q, note: 'quality dropped; stepping back' });
        this.config = { ...top.prev };
        this.pendingApply = { ...top.prev };
        // conditions changed: measure the stepped-back settings afresh before comparing anything
        this.phase = 'baseline';
      }
      this.steady = this.newWindow();
    }
    if (this.now() - this.lastReprobe > this.o.reprobeMs && this.rejected.size > 0) {
      this.lastReprobe = this.now();
      const [first] = [...this.rejected.entries()].sort((a, b) => a[1] - b[1]);
      if (first) {
        this.rejected.delete(first[0]);
        this.log({ kind: 'reprobe', experiment: first[0] });
        this.nextExperiment();
      }
    }
  }

  summary(): { config: TuneConfig; accepted: string[]; rejected: string[]; bestRate: number; bestQuality: number } {
    return {
      config: { ...this.config },
      accepted: this.accepted.map((a) => a.exp.id),
      rejected: [...this.rejected.keys()],
      bestRate: this.best.rate,
      bestQuality: this.best.quality,
    };
  }
}
