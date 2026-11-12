import { reportFeatures } from '../coding/report.ts';
import type { CodingDeps } from '../coding/run.ts';
import type {
  CarReader,
  CodingEvent,
  CodingRequest,
  DidRead,
  IdentifyResult,
  ModuleAddress,
} from '../coding/types.ts';
import { feedCodingEvent } from '../diagnostics.ts';
import { maskVin, normalizeVin } from '../vin.ts';
import { buildCarMap, type DeepSweep, type ScanDiscovery, type ScanStop, type UnitReads } from './map.ts';
import { readPlan } from './plan.ts';
import { type ReadOnlyLink, ReadOnlyViolation, readOnlyLink } from './readonly.ts';
import { type ScanUnit, selectScanUnits } from './units.ts';

/** Whole-scan ceiling: discovery of every address (unfitted ones cost ~13 s each) plus every fitted unit's plan. */
export const SCAN_BUDGET_MS = 45 * 60_000;
/** With the deep sweep (two units, three ranges each). */
export const DEEP_SCAN_BUDGET_MS = 110 * 60_000;
/** One unit's read plan: the BCM's (~400 identifiers at ~0.8 s each) fits with room for retries. */
export const SCAN_UNIT_BUDGET_MS = 10 * 60_000;
/** One deep-sweep range. */
export const DEEP_RANGE_BUDGET_MS = 10 * 60_000;
/** Consecutive unanswered reads after which a unit is left partial (it went quiet). */
const SCAN_SILENT_STREAK = 8;
/** Consecutive unanswered reads after which a deep range is left (refusals are answers and never count). */
const DEEP_SILENT_STREAK = 16;
/** Presence reads per address: a second one costs nothing once the adapter's search has failed three times. */
const PROBE_ATTEMPTS = 2;
/** Adapter re-establishments per phase (discovery, then each unit). */
const RELINK_MAX = 3;
/** Reads per adapter configuration; a progress event follows each batch. */
const BATCH = 25;

const asciiOf = (hex: string): string =>
  (hex.match(/../g) ?? [])
    .map((b) => String.fromCharCode(Number.parseInt(b, 16)))
    .join('')
    .replace(/\0/g, '')
    .trim();

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Probe =
  | { kind: 'part'; hex: string }
  | { kind: 'refused'; code: string }
  | { kind: 'silent' | 'unreachable' }
  | { kind: 'lost' };

/** One presence read per attempt (F187), all under one adapter configuration. */
async function probeUnit(link: ReadOnlyLink, module: ModuleAddress): Promise<Probe> {
  const probe = async (reader: CarReader): Promise<Probe> => {
    let last: DidRead | undefined;
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      last = await reader.readDid(module, 'F187');
      if (last.kind === 'ok') return { kind: 'part', hex: last.bytes.toUpperCase() };
      if (last.kind === 'nrc') return { kind: 'refused', code: last.code };
      if (last.kind === 'link-lost') return { kind: 'lost' };
      // A pending or truncated answer is still the module answering.
      if (last.detail) return { kind: 'part', hex: last.partial ?? '' };
    }
    return last?.kind === 'no-reply' && last.adapter === 'UNABLE TO CONNECT'
      ? { kind: 'unreachable' }
      : { kind: 'silent' };
  };
  try {
    return await (link.withReads ? link.withReads(module, probe) : probe(link));
  } catch (e) {
    if (e instanceof ReadOnlyViolation) throw e;
    return { kind: 'lost' };
  }
}

/** A unit being read: its queue, where it stands, and what it answered so far. */
interface UnitScan {
  reads: UnitReads;
  queue: string[];
  cursor: number;
  stage: 'main' | 'retry' | 'deep' | 'done';
  silentStreak: number;
  startedAt: number;
  /** Deep ranges still to walk, the current one first. */
  ranges: { from: string; to: string; dids: string[]; startedAt?: number; sweep: DeepSweep }[];
}

type Step = 'more' | 'done' | 'partial' | 'lost' | 'cancelled' | 'budget';

/**
 * A full car scan: every known unit address probed for presence, then every fitted unit's read plan walked
 * (identity, 0600, recipe identifiers, lamp records, the backup manifest, and with `deep` the identifier
 * ranges of 09 and 17), then the car map. Read-only by construction: the link it uses refuses anything but
 * `22` reads, and the connection's send policy is locked to reads while the scan holds it.
 *
 * Bounded: a whole-scan budget, a per-unit budget, a silence streak per unit and per deep range. A dropped
 * adapter is re-established (bounded) and the scan resumes at the identifier it was reading.
 */
export async function* runFullScan(
  req: Extract<CodingRequest, { kind: 'inspect' }>,
  deps: CodingDeps,
): AsyncGenerator<CodingEvent, void> {
  const now = deps.now ?? (() => new Date());
  const emit = (e: DistributiveOmit<CodingEvent, 'at'>): CodingEvent => {
    const event = { ...e, at: now().toISOString() } as CodingEvent;
    feedCodingEvent(event);
    return event;
  };
  const { signal } = deps;
  const deep = !!req.scan?.deep;
  const targets = selectScanUnits(req.scan?.units);
  const budget = deep ? DEEP_SCAN_BUDGET_MS : SCAN_BUDGET_MS;
  const started = now();
  const elapsed = () => now().getTime() - started.getTime();
  yield emit({ type: 'verify-started' });
  if (!targets.length) {
    const detail = 'None of those parts of your car can be read yet, so there is nothing to read.';
    yield emit({ type: 'refused', reason: 'invalid-plan', detail });
    yield emit({ type: 'outcome', outcome: 'not-sent', phase: detail });
    return;
  }

  let link = readOnlyLink(deps.link);
  let relinks = 0;
  const relinkOnce = async (): Promise<boolean> => {
    if (!deps.relink || relinks >= RELINK_MAX) return false;
    const next = await deps.relink().catch(() => undefined);
    if (!next) return false;
    relinks += 1;
    link.release();
    link = readOnlyLink(next);
    deps.audit?.relink?.(next);
    return true;
  };

  try {
    // ---- identify: recorded, never gated ----------------------------------------------------
    let ident: IdentifyResult;
    for (;;) {
      ident = await link.identify(targets[0]?.module).catch((e): IdentifyResult => {
        if (e instanceof ReadOnlyViolation) throw e;
        return { kind: 'link-lost' };
      });
      if (ident.kind === 'link-lost' && (await relinkOnce())) {
        yield emit({ type: 'relink', attempt: relinks });
        continue;
      }
      break;
    }
    if (ident.kind === 'link-lost') {
      yield emit({ type: 'link-lost' });
      yield emit({
        type: 'outcome',
        outcome: 'not-sent',
        phase: 'The adapter disconnected before anything was read.',
      });
      return;
    }
    const vin = ident.kind === 'ok' ? normalizeVin(ident.vin) : undefined;

    // ---- discovery: one presence read per address ----------------------------------------------
    let stopped: ScanStop | undefined;
    const discovery: ScanDiscovery[] = [];
    const parts = new Map<string, string>();
    relinks = 0;
    let verified = false;
    const carVerified = () =>
      emit({
        type: 'car-verified',
        ...(vin ? { vin } : {}),
        vinMasked: vin ? maskVin(vin) : 'unidentified',
        part: discovery[0]?.part ?? '',
      });
    for (let i = 0; i < targets.length; ) {
      const t = targets[i] as ScanUnit;
      if (signal.aborted) {
        stopped = 'cancelled';
        break;
      }
      if (elapsed() > budget) {
        stopped = 'budget';
        break;
      }
      const r = await probeUnit(link, t.module);
      if (r.kind === 'lost') {
        if (await relinkOnce()) {
          yield emit({ type: 'relink', attempt: relinks });
          continue;
        }
        stopped = 'lost';
        break;
      }
      const entry: ScanDiscovery = {
        unit: t.unit,
        aliases: t.aliases,
        request: t.module.request,
        response: t.module.response,
        label: t.label,
        source: t.source,
        fitted: r.kind === 'part' || r.kind === 'refused',
        answer: r.kind,
        ...(r.kind === 'part' && r.hex ? { part: asciiOf(r.hex) } : {}),
        ...(r.kind === 'refused' ? { nrc: r.code } : {}),
      };
      if (r.kind === 'part' && r.hex) parts.set(t.module.request, r.hex);
      discovery.push(entry);
      yield emit({
        type: 'scan-progress',
        phase: 'discover',
        unit: t.unit,
        done: i + 1,
        total: targets.length,
        fitted: entry.fitted,
      });
      if (!verified) {
        verified = true;
        yield carVerified();
      }
      i += 1;
    }
    if (!verified) yield carVerified();
    for (const t of targets.slice(discovery.length))
      discovery.push({
        unit: t.unit,
        aliases: t.aliases,
        request: t.module.request,
        response: t.module.response,
        label: t.label,
        source: t.source,
        fitted: false,
        answer: 'not-probed',
      });
    yield emit({ type: 'scan-discovery', units: discovery });

    // ---- read every fitted unit ----------------------------------------------------------------
    yield emit({ type: 'check-started' });
    const done: UnitReads[] = [];
    const fitted = targets.filter((t) => discovery.find((d) => d.request === t.module.request)?.fitted);
    for (const t of stopped ? [] : fitted) {
      if (signal.aborted) {
        stopped = 'cancelled';
        break;
      }
      if (elapsed() > budget) {
        stopped = 'budget';
        break;
      }
      const plan = readPlan(t, { deep });
      const partHex = parts.get(t.module.request);
      const s: UnitScan = {
        reads: {
          unit: t.unit,
          aliases: t.aliases,
          module: t.module,
          label: t.label,
          answered: partHex ? { F187: partHex } : {},
          truncated: {},
          refused: {},
          silent: [],
          pending: [],
          complete: false,
        },
        // The presence read already answered F187.
        queue: plan.dids.filter((d) => !(d === 'F187' && partHex)),
        cursor: 0,
        stage: 'main',
        silentStreak: 0,
        startedAt: now().getTime(),
        ranges: plan.deep.map((r) => ({
          ...r,
          sweep: { from: r.from, to: r.to, read: 0, stoppedEarly: false },
        })),
      };
      const total = plan.dids.length + plan.deep.reduce((n, r) => n + r.dids.length, 0);
      relinks = 0;
      let step: Step;
      let readSoFar = 0;
      for (;;) {
        step = await advance(link, s, { now, signal, deadline: started.getTime() + budget });
        if (step === 'lost' && (await relinkOnce())) {
          yield emit({ type: 'relink', attempt: relinks });
          continue;
        }
        const read = Object.keys(s.reads.answered).length + Object.keys(s.reads.refused).length;
        if (step === 'more' && read - readSoFar >= BATCH) {
          readSoFar = read;
          yield emit({ type: 'scan-progress', phase: 'read', unit: t.unit, done: read, total });
        }
        if (step !== 'more') break;
      }
      s.reads.complete = step === 'done';
      if (s.ranges.length)
        s.reads.deep = s.ranges.map((r) => ({
          ...r.sweep,
          stoppedEarly: r.sweep.stoppedEarly || r.sweep.read < r.dids.length,
        }));
      done.push(s.reads);
      const silent = [...s.reads.silent, ...s.reads.pending, ...Object.keys(s.reads.truncated)];
      yield emit({
        type: 'module-scan',
        unit: t.unit,
        part: partHex ? asciiOf(partHex) : '',
        ...(s.reads.answered.F19E ? { odx: asciiOf(s.reads.answered.F19E) } : {}),
        answered: s.reads.answered,
        refused: s.reads.refused,
        silent,
        complete: s.reads.complete,
      });
      const unresolved = new Set([...silent, ...s.queue.slice(s.cursor)]);
      yield emit({
        type: 'feature-report',
        unit: t.unit,
        entries: reportFeatures(t.unit, t.module.request, s.reads.answered, unresolved),
      });
      if (step === 'cancelled' || step === 'lost' || step === 'budget') {
        stopped = step;
        break;
      }
    }

    // ---- the map -------------------------------------------------------------------------------
    const map = buildCarMap({
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      ...(vin ? { vin } : {}),
      deep,
      ...(stopped ? { stopped } : {}),
      discovery,
      units: done,
    });
    yield emit({ type: 'car-map', map });
    const t = map.totals;
    const summary = `${t.values} settings across ${t.fitted} parts of your car`;
    if (stopped === 'lost') {
      yield emit({ type: 'link-lost' });
      yield emit({
        type: 'outcome',
        outcome: 'pending-uncertain',
        phase: 'The adapter disconnected during the scan. What we read so far is saved.',
      });
      return;
    }
    if (stopped === 'cancelled') {
      yield emit({
        type: 'outcome',
        outcome: 'cancelled',
        phase: 'Scan cancelled. What we read so far is saved.',
      });
      return;
    }
    if (!map.complete) {
      yield emit({
        type: 'outcome',
        outcome: 'pending-uncertain',
        phase: `The scan stopped early after reading ${summary}. What we read so far is saved.`,
      });
      return;
    }
    yield emit({ type: 'readback', observed: `Read ${summary}`, matches: t.values > 0 });
    yield emit({ type: 'outcome', outcome: 'verified', phase: `Read ${summary}.` });
  } finally {
    link.release();
  }
}

/**
 * Reads up to one batch of the unit's plan under one adapter configuration. A lost link leaves the cursor on
 * the identifier being read: calling again (after a relink) resumes there, never restarts.
 */
async function advance(
  link: ReadOnlyLink,
  s: UnitScan,
  ctx: { now: () => Date; signal: AbortSignal; deadline: number },
): Promise<Step> {
  const module = s.reads.module;
  const walk = async (reader: CarReader): Promise<Step> => {
    for (let n = 0; n < BATCH; n++) {
      if (ctx.signal.aborted) return 'cancelled';
      // One clock read per identifier: the budget checks share it.
      const at = ctx.now().getTime();
      if (at > ctx.deadline) return 'budget';
      if (s.stage === 'main' || s.stage === 'retry') {
        if (at - s.startedAt > SCAN_UNIT_BUDGET_MS) return 'partial';
        const did = s.queue[s.cursor];
        if (did === undefined) {
          // The plan is walked: one bounded re-read of whatever went quiet (adapter timing makes real
          // identifiers look silent; a DID silent twice is honestly silent), then the deep ranges.
          if (s.stage === 'main' && s.reads.silent.length) {
            s.queue = [...s.reads.silent];
            s.reads.silent = [];
            s.cursor = 0;
            s.stage = 'retry';
            s.silentStreak = 0;
            continue;
          }
          s.stage = s.ranges.length ? 'deep' : 'done';
          continue;
        }
        const r = await reader.readDid(module, did);
        if (r.kind === 'link-lost') return 'lost';
        record(s.reads, did, r);
        s.cursor += 1;
        s.silentStreak = r.kind === 'no-reply' && !r.detail ? s.silentStreak + 1 : 0;
        // The unit went quiet: what was not reached stays unread (the map says so).
        if (s.silentStreak >= SCAN_SILENT_STREAK) return 'partial';
        continue;
      }
      if (s.stage === 'deep') {
        const range = s.ranges.find((r) => r.sweep.read < r.dids.length && !r.sweep.stoppedEarly);
        if (!range) {
          s.stage = 'done';
          continue;
        }
        range.startedAt ??= at;
        if (at - range.startedAt > DEEP_RANGE_BUDGET_MS) {
          range.sweep.stoppedEarly = true;
          continue;
        }
        const did = range.dids[range.sweep.read] as string;
        const r = await reader.readDid(module, did);
        if (r.kind === 'link-lost') return 'lost';
        // A deep read that is refused is simply not hosted: only answers are kept, refusals are not listed.
        if (r.kind === 'ok') s.reads.answered[did] = r.bytes.toUpperCase();
        else if (r.kind === 'no-reply' && r.detail === 'truncated') s.reads.truncated[did] = r.partial ?? '';
        else if (r.kind === 'no-reply' && r.detail === 'pending') s.reads.pending.push(did);
        range.sweep.read += 1;
        s.silentStreak = r.kind === 'no-reply' && !r.detail ? s.silentStreak + 1 : 0;
        if (s.silentStreak >= DEEP_SILENT_STREAK) {
          range.sweep.stoppedEarly = true;
          s.silentStreak = 0;
        }
        continue;
      }
      return 'done';
    }
    return s.stage === 'done' ? 'done' : 'more';
  };
  try {
    return await (link.withReads ? link.withReads(module, walk) : walk(link));
  } catch (e) {
    if (e instanceof ReadOnlyViolation) throw e;
    return 'lost';
  }
}

function record(u: UnitReads, did: string, r: Exclude<DidRead, { kind: 'link-lost' }>): void {
  delete u.truncated[did];
  u.pending = u.pending.filter((d) => d !== did);
  switch (r.kind) {
    case 'ok':
      u.answered[did] = r.bytes.toUpperCase();
      return;
    case 'nrc':
      u.refused[did] = r.code;
      return;
    case 'no-reply':
      if (r.detail === 'truncated') u.truncated[did] = r.partial ?? '';
      else if (r.detail === 'pending') u.pending.push(did);
      else u.silent.push(did);
  }
}
