import { pidDefOrRaw, unitSymbol } from '@obdcraft/definitions';

/**
 * Live data logging for the evidence session (`live log --scenario <A-F|name>`): which PIDs to log, the CSV format,
 * and the per-scenario summary computed from the CSV (so `live report` can recompute it from the file alone).
 *
 * One CSV row per sample: the ms since the start, the wall-clock time, and every PID decoded with its unit. A row
 * carries the values that arrived in that sample; a blank cell means that PID was not read in that sample (the
 * link polls in batches as fast as it manages). MARK rows are the owner's marks (Enter in the logging terminal, or
 * `live mark` from another shell) with their note. Lines starting with `#` are metadata: scenario, supported and
 * unsupported PIDs, barometric pressure, the mode 06 misfire counters at the start and the end.
 */

export interface Scenario {
  id: string;
  title: string;
  /** What to do, for the plan and the log header. */
  how: string;
  /** Short logging set (full-throttle pulls need the highest rate on the few PIDs that matter). */
  fast: boolean;
}

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  A: {
    id: 'A',
    title: 'cold start',
    how: 'engine cold (parked overnight), start and idle 3 minutes, no throttle',
    fast: false,
  },
  B: {
    id: 'B',
    title: 'warm idle, AC off then on',
    how: 'warm engine, idle 1 minute AC off, then 1 minute AC on (mark when switching)',
    fast: false,
  },
  C: { id: 'C', title: 'city driving', how: '10 minutes of normal city driving', fast: false },
  D: {
    id: 'D',
    title: 'full-throttle pull in D',
    how: 'from about 20 km/h in D, pedal fully down until about 80 km/h (safe, legal road)',
    fast: true,
  },
  E: {
    id: 'E',
    title: 'full-throttle pull in S / manual',
    how: 'same pull in S, then in manual holding a lower gear from about 2500 rpm',
    fast: true,
  },
  F: {
    id: 'F',
    title: 'clatter marks',
    how: 'normal driving; the passenger presses Enter (or runs `live mark`) each time the clatter is heard',
    fast: false,
  },
};

export function scenarioOf(name: string): Scenario {
  const key = name.trim().toUpperCase();
  return (
    SCENARIOS[key] ?? {
      id: name.trim() || 'log',
      title: name.trim() || 'log',
      how: 'owner-defined scenario',
      fast: false,
    }
  );
}

/**
 * Default set: rpm 0C, speed 0D, load 04, absolute load 43, throttle 11, pedal 49/4A, MAP 0B, baro 33, boost 70,
 * rail pressure 23 / 59 / 6D, timing 0E, fuel trims 06/07, lambda 24/34/44, coolant 05, intake air 0F, oil 5C, MAF 10.
 */
export const DEFAULT_PIDS: readonly number[] = [
  0x0c, 0x0d, 0x04, 0x43, 0x11, 0x49, 0x4a, 0x0b, 0x33, 0x70, 0x23, 0x59, 0x6d, 0x0e, 0x06, 0x07, 0x24, 0x34,
  0x44, 0x05, 0x0f, 0x5c, 0x10,
];
/** --fast: rpm, speed, pedal, throttle, MAP, timing, rail pressure (23, else 59, else 6D), boost 70. */
export const FAST_PIDS: readonly number[] = [0x0c, 0x0d, 0x49, 0x11, 0x0b, 0x0e, 0x23, 0x70];
const RAIL_FALLBACK: readonly number[] = [0x23, 0x59, 0x6d];

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Parses `0C,0D,49` (hex PIDs). */
export function parsePidList(text: string): number[] {
  const out: number[] = [];
  for (const t of text.split(/[\s,]+/).filter(Boolean)) {
    if (!/^[0-9A-Fa-f]{1,2}$/.test(t)) throw new Error(`not a PID: "${t}" (hex, e.g. 0C,0D,49)`);
    const n = Number.parseInt(t, 16);
    if (n % 0x20 === 0) throw new Error(`PID ${hx(n)} is a support bitmap, not a value`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Only PIDs the ECU reports supported (its 0100/0120/… bitmaps) are logged; the rest are listed as unsupported in
 * the header. With --fast, a missing 23 falls back to 59, then 6D (the Kushaq reports rail pressure only in 6D).
 */
export function selectPids(
  requested: readonly number[],
  supported: ReadonlySet<number>,
  fast = false,
): { use: number[]; unsupported: number[] } {
  const want = [...requested];
  if (fast && want.includes(0x23) && !supported.has(0x23)) {
    const alt = RAIL_FALLBACK.find((p) => supported.has(p));
    if (alt !== undefined && !want.includes(alt)) want.push(alt);
  }
  return {
    use: want.filter((p) => supported.has(p)),
    unsupported: requested.filter((p) => !supported.has(p)),
  };
}

export interface LogColumn {
  pid: string;
  key: string;
  unit: string;
}

/** One column per decoded field of each PID (support bitmask fields left out). */
export function columnsFor(pids: readonly number[]): LogColumn[] {
  const out: LogColumn[] = [];
  for (const p of pids) {
    const def = pidDefOrRaw(p);
    if (!def) continue;
    for (const f of def.fields) {
      if (f.kind === 'bitmask' || f.kind === 'readiness') continue;
      out.push({ pid: hx(p), key: f.key, unit: unitSymbol(f.unit) });
    }
  }
  return out;
}

export interface LogRow {
  t: number;
  time: string;
  type: 'sample' | 'MARK';
  note?: string;
  values: Record<string, number | null>;
}

export interface LogFile {
  scenario: string;
  meta: Record<string, string>;
  columns: LogColumn[];
  rows: LogRow[];
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function csvHeader(columns: readonly LogColumn[]): string {
  return [
    't_ms',
    'time',
    'type',
    'note',
    ...columns.map((c) => `${c.pid}:${c.key}${c.unit ? ` (${c.unit})` : ''}`),
  ]
    .map(csvCell)
    .join(',');
}

export function csvMeta(key: string, value: string): string {
  return `# ${key}: ${value.replace(/\n/g, ' ')}`;
}

export function csvRow(columns: readonly LogColumn[], row: LogRow): string {
  return [
    String(Math.round(row.t)),
    row.time,
    row.type,
    row.note ?? '',
    ...columns.map((c) => {
      const v = row.values[c.key];
      return v === null || v === undefined ? '' : String(Math.round(v * 1000) / 1000);
    }),
  ]
    .map(csvCell)
    .join(',');
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseLogCsv(text: string): LogFile {
  const meta: Record<string, string> = {};
  let columns: LogColumn[] = [];
  const rows: LogRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const m = /^#\s*([^:]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1]!.trim()] = m[2]!.trim();
      continue;
    }
    const cells = splitCsv(line);
    if (cells[0] === 't_ms') {
      columns = cells.slice(4).map((c) => {
        const m = /^([0-9A-F]{2}):(\S+)(?: \((.*)\))?$/.exec(c);
        return { pid: m?.[1] ?? '', key: m?.[2] ?? c, unit: m?.[3] ?? '' };
      });
      continue;
    }
    const values: Record<string, number | null> = {};
    columns.forEach((c, i) => {
      const v = cells[4 + i];
      values[c.key] = v === undefined || v === '' ? null : Number(v);
    });
    rows.push({
      t: Number(cells[0]),
      time: cells[1] ?? '',
      type: cells[2] === 'MARK' ? 'MARK' : 'sample',
      ...(cells[3] ? { note: cells[3] } : {}),
      values,
    });
  }
  return { scenario: meta.scenario ?? 'log', meta, columns, rows };
}

// ---- the summary --------------------------------------------------------------------------------

/**
 * Thresholds of the summary and the report. They are engineering heuristics for a petrol turbo engine, not
 * manufacturer limits: a reading past one is "suspicious" (worth the advisor's attention), never a diagnosis.
 */
export const THRESHOLDS = Object.freeze({
  /** Pedal position (PID 49) above which a sample counts as full throttle. */
  fullThrottlePedalPct: 90,
  /** When the pedal never reaches 90 % (some pedals read ~80 % flat out), 90 % of the highest pedal seen, if ≥ 70 %. */
  fullThrottleRelative: 0.9,
  fullThrottleMinPedalPct: 70,
  /**
   * Pedal-down to full boost longer than this: "long delay before power". Full boost is the first MAP sample at 90 %
   * of the event's peak boost ({@link fullBoostFraction}); only the bracket's lower bound counts (the PIDs are sampled
   * one by one, ~0.5-1.4 s apart: the true moment lies somewhere between two samples).
   */
  slowBoostMs: 3000,
  /** Boost (MAP minus baro) at this fraction of the event's peak counts as "full boost". */
  fullBoostFraction: 0.9,
  /** Boost (MAP minus baro) below this at full throttle: the turbo is not building pressure. */
  lowBoostKpa: 40,
  /**
   * Ignition timing at or below this at full throttle is looked at as possible knock retard. It is flagged only when
   * it is not a shift or pedal-lift torque cut (see {@link shiftWindowMs}), persists for
   * {@link retardMinSamples} timing samples, and is {@link retardMarginDeg} below the same log's median full-load
   * timing at similar rpm ({@link retardRpmBandRpm}); otherwise it is the base map and reported as normal.
   */
  knockRetardDeg: 0,
  /** An rpm fall larger than this between two rpm samples at full throttle is an upshift (torque cut). */
  shiftRpmDrop: 300,
  /**
   * Timing samples during an upshift's rpm fall, up to this long after it, or {@link shiftLeadMs} before it are the
   * shift's deliberate torque cut, not knock.
   */
  shiftWindowMs: 1500,
  shiftLeadMs: 500,
  /** Consecutive low timing samples needed before a retard counts. */
  retardMinSamples: 2,
  /** How far below the log's median full-load timing (at similar rpm) a reading must be to count as retard. */
  retardMarginDeg: 4,
  /** "Similar rpm" for the median full-load timing: ± this. */
  retardRpmBandRpm: 500,
  /** Fewer full-load timing samples than this at similar rpm: no reference, the reading is not judged. */
  retardMinReference: 3,
  /**
   * Low-rpm load timing retard (a clatter clue): timing at or below this below {@link lowRpmMax} rpm while the engine
   * is loaded ({@link lowRpmLoadPct} load or {@link lowRpmMapKpa} MAP). Knock retard or a planned torque reserve:
   * generic OBD cannot tell them apart.
   */
  lowRpmRetardDeg: -10,
  lowRpmMax: 1300,
  /** Below this the engine is not running (cranking, stalled, ignition on): not judged. */
  lowRpmMin: 400,
  lowRpmLoadPct: 30,
  lowRpmMapKpa: 80,
  /** Colder than this the engine heats its catalyst with retarded timing on purpose: not judged. */
  lowRpmMinCoolantC: 40,
  /**
   * The same after a start the log saw (rpm from below {@link lowRpmMin} to running): catalyst heating, not judged
   * (live 2026-11-09 log A: -19 to -21 degrees at 762 rpm in the first seconds after the start, coolant 41 °C).
   */
  lowRpmAfterStartMs: 60_000,
  /** Rail pressure below this at full throttle (direct injection runs ~10-20 MPa under load). */
  lowRailKpa: 5000,
  /** Commanded minus actual boost (PID 70) above this at full throttle: boost control cannot reach its target. */
  boostShortfallKpa: 20,
  /** Short or long term fuel trim beyond ±this for longer than {@link trimSustainMs}. */
  trimPct: 10,
  trimSustainMs: 30_000,
  /** A log whose first coolant reading is below this is a cold start. */
  coldStartMaxC: 40,
  /** Coolant warmer than this counts as warmed up. */
  warmC: 80,
  /** Mode 06 misfire counter (TID 0B, averaged over recent cycles) at or above this on a cylinder: suspicious. */
  misfireCount: 10,
});

export interface ThrottleEvent {
  startMs: number;
  endMs: number;
  pedalMaxPct: number;
  speedStartKmh: number | null;
  speedEndKmh: number | null;
  rpmStart: number | null;
  rpmPeak: number | null;
  rpmRise: number | null;
  mapPeakKpa: number | null;
  /** Pedal-down to the highest MAP of the event (sample times; see `fullBoostMs` for the honest bracket). */
  msToPeakMap: number | null;
  /**
   * Pedal-down to full boost (first MAP sample at {@link THRESHOLDS.fullBoostFraction} of the peak boost), as a
   * bracket from the neighbouring samples: at least `lo` (the MAP sample before was still short of it, read after the
   * pedal went down), at most `hi` (from the last pedal sample below full throttle to the MAP sample that reached it).
   */
  fullBoostMs: { lo: number; hi: number } | null;
  /** Peak MAP minus barometric pressure. */
  boostKpa: number | null;
  /** Lowest timing sample of the event, whatever caused it. */
  timingMinDeg: number | null;
  /** Lowest timing sample with the pedal held and no shift near it (null when there is none). */
  timingMinSteadyDeg: number | null;
  /** Low timing samples (at or below {@link THRESHOLDS.knockRetardDeg}) left out: a shift or a pedal lift. */
  timingExcluded: { t: number; deg: number; rpm: number | null; why: 'upshift' | 'pedal lift' }[];
  /** A persistent, material retard with the pedal held and no shift (see {@link THRESHOLDS.knockRetardDeg}). */
  timingRetard: {
    startMs: number;
    endMs: number;
    samples: { t: number; deg: number; rpm: number | null; refDeg: number }[];
  } | null;
  railMinKpa: number | null;
  /** Largest commanded-minus-actual boost (PID 70), when logged. */
  boostShortfallKpa: number | null;
}

export interface TrimRun {
  key: string;
  startMs: number;
  endMs: number;
  meanPct: number;
}

export interface MarkAt {
  t: number;
  time: string;
  note: string;
  rpm: number | null;
  speed: number | null;
  load: number | null;
  timing: number | null;
  map: number | null;
}

/** Steady full-load timing by rpm band (pedal held, no shift): what this engine's base map does flat out. */
export interface TimingBand {
  rpmFrom: number;
  rpmTo: number;
  minDeg: number;
  maxDeg: number;
  medianDeg: number;
  samples: number;
}

/** Timing at or below {@link THRESHOLDS.lowRpmRetardDeg} at low rpm under load, grouped into episodes. */
export interface LowRpmRetard {
  startMs: number;
  endMs: number;
  minDeg: number;
  samples: {
    t: number;
    deg: number;
    rpm: number;
    load: number | null;
    map: number | null;
    speed: number | null;
    coolant: number | null;
  }[];
}

export interface LogSummary {
  scenario: string;
  durationMs: number;
  samples: number;
  /** Samples per second over the whole log. */
  rate: number;
  pedalKey: string | null;
  fullThrottleThresholdPct: number | null;
  throttleEvents: ThrottleEvent[];
  /** Steady full-load timing bands of the whole log (1000 rpm wide). */
  fullLoadTiming: TimingBand[];
  lowRpmRetard: LowRpmRetard[];
  trimRuns: TrimRun[];
  trimMeans: Record<string, number>;
  warmup: {
    coldStart: boolean;
    startC: number | null;
    points: { s: number; c: number }[];
    msToWarm: number | null;
    endC: number | null;
  } | null;
  marks: MarkAt[];
  notes: string[];
}

type Point = { t: number; v: number };

function series(rows: readonly LogRow[], key: string): Point[] {
  const out: Point[] = [];
  for (const r of rows) {
    const v = r.values[key];
    if (r.type === 'sample' && v !== null && v !== undefined && Number.isFinite(v)) out.push({ t: r.t, v });
  }
  return out;
}

const firstKey = (rows: readonly LogRow[], keys: readonly string[]) =>
  keys.find((k) => series(rows, k).length > 0) ?? null;
const at = (s: readonly Point[], t: number): number | null => {
  let best: Point | undefined;
  for (const p of s) if (p.t <= t) best = p;
  return best?.v ?? s[0]?.v ?? null;
};
const within = (s: readonly Point[], a: number, b: number) => s.filter((p) => p.t >= a && p.t <= b);
/** The value at `t` interpolated between the samples around it (each within `maxMs`), else the nearer one. */
const interp = (s: readonly Point[], t: number, maxMs = 2000): number | null => {
  let a: Point | undefined;
  let b: Point | undefined;
  for (const p of s) {
    if (p.t <= t) a = p;
    else {
      b = p;
      break;
    }
  }
  const okA = a && t - a.t <= maxMs ? a : undefined;
  const okB = b && b.t - t <= maxMs ? b : undefined;
  if (okA && okB) return okA.t === okB.t ? okA.v : okA.v + ((okB.v - okA.v) * (t - okA.t)) / (okB.t - okA.t);
  return okA?.v ?? okB?.v ?? null;
};
/** The sample nearest to `t`, when one is within `maxMs`. */
const near = (s: readonly Point[], t: number, maxMs = 1500): number | null => {
  let best: Point | undefined;
  for (const p of s) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best && Math.abs(best.t - t) <= maxMs ? best.v : null;
};
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

export function summarizeLog(file: LogFile): LogSummary {
  const rows = file.rows;
  const samples = rows.filter((r) => r.type === 'sample');
  const durationMs = rows.length ? rows[rows.length - 1]!.t - rows[0]!.t : 0;
  const notes: string[] = [];
  for (const k of ['misfire-start', 'misfire-end'])
    if (file.meta[k]) notes.push(`mode 06 ${k}: ${file.meta[k]}`);
  const pedalKey = firstKey(rows, ['pedal_d', 'pedal_e', 'throttle']);
  if (pedalKey && pedalKey !== 'pedal_d')
    notes.push(`pedal position D (PID 49) not logged: full throttle detected from ${pedalKey}`);
  const pedal = pedalKey ? series(rows, pedalKey) : [];
  const pedalMax = pedal.reduce((m, p) => Math.max(m, p.v), 0);
  let thr: number | null = null;
  if (pedal.length) {
    if (pedalMax > THRESHOLDS.fullThrottlePedalPct) thr = THRESHOLDS.fullThrottlePedalPct;
    else if (pedalMax >= THRESHOLDS.fullThrottleMinPedalPct) {
      thr = Math.round(pedalMax * THRESHOLDS.fullThrottleRelative * 10) / 10;
      notes.push(
        `pedal never above ${THRESHOLDS.fullThrottlePedalPct} % (max ${pedalMax.toFixed(1)} %): full throttle taken as above ${thr} %`,
      );
    }
  }
  const rpm = series(rows, 'rpm');
  const speed = series(rows, 'speed');
  const map = series(rows, 'map');
  const timing = series(rows, 'timing_advance');
  const railKey = firstKey(rows, [
    'fuel_rail_pressure_gauge',
    'fuel_rail_pressure_abs',
    'fuel_pressure_ctrl_act_a',
  ]);
  const rail = railKey ? series(rows, railKey) : [];
  const baroSeries = series(rows, 'baro').map((p) => p.v);
  const baro = median(baroSeries) ?? (file.meta.baro_kpa ? Number(file.meta.baro_kpa) : null);
  const boostCmd = series(rows, 'boost_cmd_a');
  const boostAct = series(rows, 'boost_act_a');

  // Full-throttle windows: pedal above the threshold, from its first sample above to its first sample back below.
  const windows: { s: number; end: number }[] = [];
  if (thr !== null) {
    let start: number | null = null;
    for (const p of pedal) {
      if (p.v > thr && start === null) start = p.t;
      else if (p.v <= thr && start !== null) {
        windows.push({ s: start, end: p.t });
        start = null;
      }
    }
    if (start !== null) windows.push({ s: start, end: pedal[pedal.length - 1]!.t });
  }
  // Upshifts: rpm falling over consecutive samples by more than shiftRpmDrop in all; the torque cut lies around it.
  const shifts: { a: number; b: number }[] = [];
  for (let i = 1; i < rpm.length; ) {
    if (rpm[i]!.v >= rpm[i - 1]!.v) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < rpm.length && rpm[j + 1]!.v < rpm[j]!.v) j++;
    if (rpm[i - 1]!.v - rpm[j]!.v > THRESHOLDS.shiftRpmDrop) shifts.push({ a: rpm[i - 1]!.t, b: rpm[j]!.t });
    i = j + 1;
  }
  const nearShift = (t: number) =>
    shifts.some((x) => t >= x.a - THRESHOLDS.shiftLeadMs && t <= x.b + THRESHOLDS.shiftWindowMs);
  // The pedal held through a timing sample: the pedal samples on both sides of it are above full throttle.
  const pedalHeld = (t: number) => {
    const before = at(pedal, t);
    const next = pedal.find((p) => p.t > t);
    return thr !== null && before !== null && before > thr && (!next || next.v > thr);
  };
  type TimingSample = {
    t: number;
    deg: number;
    rpm: number | null;
    steady: boolean;
    why?: 'upshift' | 'pedal lift';
  };
  const perWindow = windows.map((w) =>
    within(timing, w.s, w.end).map((p): TimingSample => {
      const r = interp(rpm, p.t);
      const why = !pedalHeld(p.t) ? 'pedal lift' : nearShift(p.t) ? 'upshift' : undefined;
      return {
        t: p.t,
        deg: p.v,
        rpm: r === null ? null : Math.round(r),
        steady: !why && r !== null,
        ...(why ? { why } : {}),
      };
    }),
  );
  const steady = perWindow.flat().filter((x) => x.steady);
  /** Median steady full-load timing of the log within ± retardRpmBandRpm, when there are enough samples. */
  const reference = (r: number): number | null => {
    const xs = steady.filter((x) => Math.abs(x.rpm! - r) <= THRESHOLDS.retardRpmBandRpm).map((x) => x.deg);
    return xs.length >= THRESHOLDS.retardMinReference ? median(xs) : null;
  };

  const events: ThrottleEvent[] = windows.map((w, wi) => {
    const { s, end } = w;
    const ev = within(pedal, s, end);
    const m = within(map, s, end);
    const peak = m.reduce<Point | null>((best, p) => (!best || p.v > best.v ? p : best), null);
    const r = within(rpm, s, end);
    const rpmStart = at(rpm, s);
    const rpmPeak = r.length ? Math.max(...r.map((p) => p.v)) : null;
    const tm = perWindow[wi]!;
    const rl = within(rail, s, end);
    let shortfall: number | null = null;
    for (const c of within(boostCmd, s, end)) {
      const a = at(boostAct, c.t);
      if (a !== null) shortfall = Math.max(shortfall ?? Number.NEGATIVE_INFINITY, c.v - a);
    }
    let fullBoostMs: ThrottleEvent['fullBoostMs'] = null;
    if (peak) {
      const target =
        baro !== null
          ? peak.v > baro
            ? baro + THRESHOLDS.fullBoostFraction * (peak.v - baro)
            : null
          : THRESHOLDS.fullBoostFraction * peak.v;
      const reach = target === null ? undefined : m.find((p) => p.v >= target);
      if (reach) {
        const pre = [...map].reverse().find((p) => p.t < reach.t);
        const pedalUp = [...pedal].reverse().find((p) => p.t < s);
        fullBoostMs = { lo: Math.max(0, (pre?.t ?? s) - s), hi: reach.t - (pedalUp?.t ?? s) };
      }
    }
    // Persistent, material retard: consecutive steady samples each retardMarginDeg below the reference.
    let best: NonNullable<ThrottleEvent['timingRetard']> | null = null;
    let run: { t: number; deg: number; rpm: number | null; refDeg: number }[] = [];
    const flush = () => {
      if (
        run.length >= THRESHOLDS.retardMinSamples &&
        (!best || Math.min(...run.map((x) => x.deg)) < Math.min(...best.samples.map((x) => x.deg)))
      )
        best = { startMs: run[0]!.t, endMs: run[run.length - 1]!.t, samples: run };
      run = [];
    };
    for (const x of tm) {
      const ref = x.steady ? reference(x.rpm!) : null;
      if (ref !== null && x.deg <= ref - THRESHOLDS.retardMarginDeg)
        run.push({ t: x.t, deg: x.deg, rpm: x.rpm, refDeg: ref });
      else flush();
    }
    flush();
    const steadyHere = tm.filter((x) => x.steady);
    return {
      startMs: s,
      endMs: end,
      pedalMaxPct: ev.length ? Math.max(...ev.map((p) => p.v)) : thr!,
      speedStartKmh: at(speed, s),
      speedEndKmh: at(speed, end),
      rpmStart,
      rpmPeak,
      rpmRise: rpmStart !== null && rpmPeak !== null ? rpmPeak - rpmStart : null,
      mapPeakKpa: peak?.v ?? null,
      msToPeakMap: peak ? peak.t - s : null,
      fullBoostMs,
      boostKpa: peak && baro !== null ? peak.v - baro : null,
      timingMinDeg: tm.length ? Math.min(...tm.map((p) => p.deg)) : null,
      timingMinSteadyDeg: steadyHere.length ? Math.min(...steadyHere.map((x) => x.deg)) : null,
      timingExcluded: tm
        .filter((x) => x.why && x.deg <= THRESHOLDS.knockRetardDeg)
        .map((x) => ({ t: x.t, deg: x.deg, rpm: x.rpm, why: x.why! })),
      timingRetard: best,
      railMinKpa: rl.length ? Math.min(...rl.map((p) => p.v)) : null,
      boostShortfallKpa: shortfall,
    };
  });

  const fullLoadTiming: TimingBand[] = [];
  for (const x of steady) {
    const from = Math.floor(x.rpm! / 1000) * 1000;
    if (!fullLoadTiming.some((b) => b.rpmFrom === from))
      fullLoadTiming.push({
        rpmFrom: from,
        rpmTo: from + 1000,
        minDeg: 0,
        maxDeg: 0,
        medianDeg: 0,
        samples: 0,
      });
  }
  for (const b of fullLoadTiming) {
    const xs = steady.filter((x) => x.rpm! >= b.rpmFrom && x.rpm! < b.rpmTo).map((x) => x.deg);
    Object.assign(b, {
      minDeg: Math.min(...xs),
      maxDeg: Math.max(...xs),
      medianDeg: median(xs)!,
      samples: xs.length,
    });
  }
  fullLoadTiming.sort((a, b) => a.rpmFrom - b.rpmFrom);

  // Low-rpm load timing retard: every timing sample of the log, wherever the pedal is.
  const loadS = series(rows, 'engine_load');
  const coolantS = series(rows, 'coolant_temp');
  const lowRpmRetard: LowRpmRetard[] = [];
  const starts: number[] = [];
  for (let i = 1; i < rpm.length; i++)
    if (rpm[i - 1]!.v < THRESHOLDS.lowRpmMin && rpm[i]!.v >= THRESHOLDS.lowRpmMin) starts.push(rpm[i - 1]!.t);
  const justStarted = (t: number) => starts.some((s0) => t >= s0 && t - s0 < THRESHOLDS.lowRpmAfterStartMs);
  for (const p of timing) {
    if (p.v > THRESHOLDS.lowRpmRetardDeg) continue;
    const r = interp(rpm, p.t);
    if (r === null || r < THRESHOLDS.lowRpmMin || r >= THRESHOLDS.lowRpmMax || justStarted(p.t)) continue;
    const ld = near(loadS, p.t);
    const mp = near(map, p.t);
    if (!((ld !== null && ld >= THRESHOLDS.lowRpmLoadPct) || (mp !== null && mp >= THRESHOLDS.lowRpmMapKpa)))
      continue;
    const cool = near(coolantS, p.t, 20_000);
    if (cool !== null && cool < THRESHOLDS.lowRpmMinCoolantC) continue;
    const sample = {
      t: p.t,
      deg: p.v,
      rpm: Math.round(r),
      load: ld,
      map: mp,
      speed: near(speed, p.t),
      coolant: cool,
    };
    const last = lowRpmRetard[lowRpmRetard.length - 1];
    if (last && p.t - last.endMs <= 5000) {
      last.samples.push(sample);
      last.endMs = p.t;
      last.minDeg = Math.min(last.minDeg, p.v);
    } else lowRpmRetard.push({ startMs: p.t, endMs: p.t, minDeg: p.v, samples: [sample] });
  }

  const trimRuns: TrimRun[] = [];
  const trimMeans: Record<string, number> = {};
  for (const key of ['stft_b1', 'ltft_b1']) {
    const s = series(rows, key);
    if (!s.length) continue;
    trimMeans[key] = Math.round((s.reduce((n, p) => n + p.v, 0) / s.length) * 10) / 10;
    let run: Point[] = [];
    const flush = () => {
      if (run.length && run[run.length - 1]!.t - run[0]!.t >= THRESHOLDS.trimSustainMs) {
        trimRuns.push({
          key,
          startMs: run[0]!.t,
          endMs: run[run.length - 1]!.t,
          meanPct: Math.round((run.reduce((n, p) => n + p.v, 0) / run.length) * 10) / 10,
        });
      }
      run = [];
    };
    for (const p of s) {
      const beyond = Math.abs(p.v) > THRESHOLDS.trimPct;
      if (beyond && run.length && Math.sign(run[0]!.v) !== Math.sign(p.v)) flush();
      if (beyond) run.push(p);
      else flush();
    }
    flush();
  }

  const coolant = series(rows, 'coolant_temp');
  let warmup: LogSummary['warmup'] = null;
  if (coolant.length) {
    const t0 = coolant[0]!.t;
    const cold = coolant[0]!.v < THRESHOLDS.coldStartMaxC;
    const points: { s: number; c: number }[] = [];
    for (let s = 0; s * 1000 <= coolant[coolant.length - 1]!.t - t0; s += 30) {
      const v = at(coolant, t0 + s * 1000);
      if (v !== null) points.push({ s, c: v });
    }
    const warm = coolant.find((p) => p.v >= THRESHOLDS.warmC);
    warmup = {
      coldStart: cold,
      startC: coolant[0]!.v,
      points,
      msToWarm: warm ? warm.t - t0 : null,
      endC: coolant[coolant.length - 1]!.v,
    };
  }

  const marks: MarkAt[] = rows
    .filter((r) => r.type === 'MARK')
    .map((r) => ({
      t: r.t,
      time: r.time,
      note: r.note ?? '',
      rpm: at(rpm, r.t),
      speed: at(speed, r.t),
      load: at(loadS, r.t),
      timing: at(timing, r.t),
      map: at(map, r.t),
    }));

  return {
    scenario: file.scenario,
    durationMs,
    samples: samples.length,
    rate: durationMs > 0 ? Math.round((samples.length / (durationMs / 1000)) * 10) / 10 : 0,
    pedalKey,
    fullThrottleThresholdPct: thr,
    throttleEvents: events,
    fullLoadTiming,
    lowRpmRetard,
    trimRuns,
    trimMeans,
    warmup,
    marks,
    notes,
  };
}

const n = (v: number | null, unit = '', digits = 0) => (v === null ? 'n/a' : `${v.toFixed(digits)}${unit}`);

/** "1.6-2.4 s" (the bracket of a sampled delay) or "n/a". */
export const bracketText = (b: { lo: number; hi: number } | null): string =>
  b === null ? 'n/a' : `${(b.lo / 1000).toFixed(1)}-${(b.hi / 1000).toFixed(1)} s`;

/** "2000-3000 rpm -2.5..0.5° (median -1, 6 samples); …" */
export const timingBandsText = (bands: readonly TimingBand[]): string =>
  bands
    .map(
      (b) =>
        `${b.rpmFrom}-${b.rpmTo} rpm ${b.minDeg}..${b.maxDeg}° (median ${b.medianDeg}°, ${b.samples} samples)`,
    )
    .join('; ');

/** The short per-scenario summary printed when the log stops. */
export function summaryLines(s: LogSummary): string[] {
  const L: string[] = [];
  L.push(`scenario ${s.scenario}: ${(s.durationMs / 1000).toFixed(1)} s, ${s.samples} samples (${s.rate}/s)`);
  for (const note of s.notes) L.push(`note: ${note}`);
  if (s.fullThrottleThresholdPct === null) L.push('full throttle: none (pedal never near full)');
  for (const [i, e] of s.throttleEvents.entries()) {
    L.push(
      `full throttle #${i + 1} at +${(e.startMs / 1000).toFixed(1)} s for ${((e.endMs - e.startMs) / 1000).toFixed(1)} s: ` +
        `pedal→full boost ${bracketText(e.fullBoostMs)}, MAP ${n(e.mapPeakKpa, ' kPa')}, boost ${n(e.boostKpa, ' kPa')}, ` +
        `rpm ${n(e.rpmStart)}→${n(e.rpmPeak)} (+${n(e.rpmRise)}), speed ${n(e.speedStartKmh)}→${n(e.speedEndKmh)} km/h, ` +
        `min timing ${n(e.timingMinDeg, '°', 1)} (pedal held, no shift: ${n(e.timingMinSteadyDeg, '°', 1)})` +
        `${e.timingRetard ? `, RETARD ${e.timingRetard.samples.map((x) => `${x.deg}° at ${n(x.rpm)} rpm vs ${x.refDeg}°`).join(', ')}` : ''}` +
        `, min rail ${n(e.railMinKpa, ' kPa')}${e.boostShortfallKpa !== null ? `, boost shortfall ${n(e.boostShortfallKpa, ' kPa')}` : ''}`,
    );
  }
  if (s.fullLoadTiming.length)
    L.push(`full-load timing (pedal held, no shift): ${timingBandsText(s.fullLoadTiming)}`);
  for (const x of s.lowRpmRetard)
    L.push(
      `low-rpm timing retard +${(x.startMs / 1000).toFixed(1)}..+${(x.endMs / 1000).toFixed(1)} s: ${x.samples.map((p) => `${p.deg}° at ${p.rpm} rpm, load ${n(p.load, ' %')}, MAP ${n(p.map, ' kPa')}`).join('; ')}`,
    );
  for (const [k, v] of Object.entries(s.trimMeans)) L.push(`${k} mean ${v} %`);
  for (const r of s.trimRuns)
    L.push(
      `${r.key} beyond ±${THRESHOLDS.trimPct} % for ${((r.endMs - r.startMs) / 1000).toFixed(0)} s from +${(r.startMs / 1000).toFixed(0)} s (mean ${r.meanPct} %)`,
    );
  if (s.warmup?.coldStart) {
    L.push(
      `cold start: coolant ${n(s.warmup.startC, ' °C')} → ${n(s.warmup.endC, ' °C')}; ${s.warmup.points.map((p) => `${p.s}s ${p.c}°C`).join(', ')}; ${s.warmup.msToWarm !== null ? `${THRESHOLDS.warmC} °C after ${(s.warmup.msToWarm / 1000).toFixed(0)} s` : `${THRESHOLDS.warmC} °C not reached`}`,
    );
  }
  for (const m of s.marks)
    L.push(
      `MARK +${(m.t / 1000).toFixed(1)} s "${m.note}": rpm ${n(m.rpm)}, ${n(m.speed, ' km/h')}, load ${n(m.load, ' %')}, timing ${n(m.timing, '°', 1)}, MAP ${n(m.map, ' kPa')}`,
    );
  return L;
}
