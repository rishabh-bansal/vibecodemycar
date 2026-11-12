/**
 * The evidence commands of the live kit (scripts/live.ts): `health`, `log`, `mark`, `compare`, `report`. The logic
 * is in src/domain/health/; this file connects it to the bridge, the files under <log-dir> and the logs.
 *
 * Read-only by construction: both connections of `health` and the one of `log` lock the adapter's send policy to the
 * health reads (`SafetyPolicy.enterHealthReadOnly`) right after the adapter is up, and every UDS request is checked
 * by `assertHealthRequest` before it is handed over. No clear (04 / 14), write, routine, IO control, security access
 * or reset can leave while either holds; the snapshot records the policy's refusals (none expected) as proof.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { withModuleRequests } from '@obdcraft/coding';
import { decodeMode06Records, MODE06 } from '@obdcraft/definitions';
import {
  bitmapPids, type FullScanResult, type OBDCraftEngine, type Reading, readDtcs, readIdentity, readMonitorTests, UdsExchangeError,
} from '@obdcraft/obd-core';
import { recordDiag } from '../../src/domain/diagnostics.ts';
import { compareSnapshots, comparisonMarkdown } from '../../src/domain/health/compare.ts';
import {
  columnsFor, csvHeader, csvMeta, csvRow, DEFAULT_PIDS, FAST_PIDS, type LogRow, parseLogCsv, parsePidList, scenarioOf, selectPids,
  summarizeLog, summaryLines,
} from '../../src/domain/health/livelog.ts';
import { obdSection } from '../../src/domain/health/obd.ts';
import { HealthReadOnlyViolation } from '../../src/domain/health/readonly.ts';
import { healthFindings, logFindings, mergeFindings, reportHtml, reportMarkdown } from '../../src/domain/health/report.ts';
import { chooseOdometer, HEALTH_SCHEMA, type HealthSnapshot, healthMarkdown, healthSummary, labelSlug } from '../../src/domain/health/snapshot.ts';
import { faultDtcs, healthRequestOptions, readUnitHealth, type UdsAnswer, type UnitHealth, udsDtcLabel, udsDtcText } from '../../src/domain/health/uds.ts';
import type { CarMap } from '../../src/domain/scan/map.ts';
import { scanUnits, type ScanUnit } from '../../src/domain/scan/units.ts';
import type { LiveLog } from './stream.ts';

/** What live.ts hands the evidence commands. */
export interface HealthKit {
  log: LiveLog;
  logDir: string;
  flags: Map<string, string | true>;
  flag: (name: string, def: string) => string;
  /** A connected engine for the duration of `work` (connection log recorded and uploaded as every command's). */
  withEngine: <T>(startup: 'obd-search' | 'diagnostic-can', work: (engine: OBDCraftEngine) => Promise<T>) => Promise<T>;
  synthetic: () => boolean;
}

const iso = () => new Date().toISOString();
const fileStamp = (s: string) => s.replace(/[:.]/g, '-');
const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Locks the engine's send policy to the health reads; returns the release. */
export function lockHealth(engine: OBDCraftEngine): { release: () => void; refused: () => string[] } {
  const policy = engine.link?.policy;
  if (!policy) throw new Error('no adapter link to lock');
  const before = policy.refused.length;
  const release = policy.enterHealthReadOnly();
  return { release, refused: () => policy.refused.slice(before).map((r) => `${r.command} (${r.reason})`) };
}

// ---- health -------------------------------------------------------------------------------------

/** Extra reads of a full-scan part that came back empty: the clone drops a request now and then (NO DATA). */
const RE_READS = 2;

/**
 * Re-reads the parts of the full scan that no ECU answered (identity, each DTC list, mode 06), up to {@link RE_READS}
 * times each, and patches them into the scan. A single dropped request must not read as "not supported".
 */
async function reReadMissing(kit: HealthKit, engine: OBDCraftEngine, scan: FullScanResult): Promise<void> {
  const ctx = engine.ctx;
  if (!ctx) return;
  for (let i = 0; i < RE_READS && !scan.identity?.items.length; i++) {
    kit.log.event('note', 'mode 09 not answered: reading it again');
    scan.identity = await readIdentity(ctx);
  }
  for (const kind of ['stored', 'pending', 'permanent'] as const) {
    for (let i = 0; i < RE_READS && (!scan.dtcs[kind] || scan.dtcs[kind]!.state === 'unavailable' || scan.dtcs[kind]!.state === 'error'); i++) {
      kit.log.event('note', `${kind} codes not answered: reading them again`);
      scan.dtcs[kind] = await readDtcs(ctx, kind);
    }
  }
  const noTests = () => !scan.monitors || (scan.monitors.applicable && !scan.monitors.perEcu.length);
  for (let i = 0; i < RE_READS && noTests(); i++) {
    kit.log.event('note', 'mode 06 not answered: reading it again');
    scan.monitors = await readMonitorTests(ctx);
  }
}

/** The unit list: --units, else the units the newest saved car map found fitted (plus engine and gearbox), else all. */
function unitList(kit: HealthKit): { units: ScanUnit[]; from: string } {
  const all = scanUnits();
  if (kit.flags.has('--units')) {
    const wanted = new Set(kit.flag('--units', '').split(',').map((u) => u.trim().toUpperCase().padStart(2, '0')).filter(Boolean));
    return { units: all.filter((u) => wanted.has(u.unit) || u.aliases.some((a) => wanted.has(a))), from: '--units' };
  }
  const dir = join(kit.logDir, 'scans');
  const maps = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const newest = maps.at(-1);
  if (newest) {
    try {
      const map = JSON.parse(readFileSync(join(dir, newest), 'utf8')) as CarMap;
      const fitted = new Set(map.units.map((u) => u.request));
      const units = all.filter((u) => fitted.has(u.module.request) || u.unit === '01' || u.unit === '02');
      if (units.length) return { units, from: `car map ${newest}` };
    } catch {
      // An unreadable map: probe every unit instead.
    }
  }
  return { units: all, from: 'every known unit address (no saved car map: run `live scan` once to make this faster)' };
}

/** A read group's request, classified for the domain (see UdsAnswer). */
export async function classify(run: () => Promise<number[]>): Promise<UdsAnswer> {
  try {
    return { kind: 'ok', bytes: await run() };
  } catch (e) {
    if (e instanceof HealthReadOnlyViolation) throw e;
    if (!(e instanceof UdsExchangeError)) return { kind: 'lost', error: (e as Error).message };
    if (e.failure === 'policy') throw new HealthReadOnlyViolation(`a request the send policy refused (${e.message})`);
    if (e.nrc !== undefined && e.nrc !== 0x78) return { kind: 'nrc', code: e.nrc };
    if (e.detail === 'truncated') return { kind: 'truncated', partial: e.partial ?? [], declared: e.declaredLength ?? null };
    if (e.detail === 'pending') return { kind: 'pending' };
    const last = e.replies.at(-1);
    const status = last?.statuses.find((s) => s === 'NO DATA' || s === 'UNABLE TO CONNECT');
    if (e.failure === 'timeout' || status) return { kind: 'no-reply', ...(status ? { adapter: status } : {}) };
    return { kind: 'lost', error: e.message };
  }
}

async function readUnits(kit: HealthKit, units: readonly ScanUnit[]): Promise<{ results: UnitHealth[]; refused: string[]; voltage: string | null }> {
  const results: UnitHealth[] = [];
  const refused: string[] = [];
  let voltage: string | null = null;
  let next = 0;
  // A unit whose read lost the link costs one reconnect; the read resumes at the next unit.
  for (let attempt = 0; attempt < 4 && next < units.length; attempt++) {
    try {
      await kit.withEngine('diagnostic-can', async (engine) => {
        voltage ??= engine.adapter.voltage ?? null;
        const lock = lockHealth(engine);
        try {
          while (next < units.length) {
            const u = units[next]!;
            const unit = { unit: u.unit, label: u.label, request: u.module.request, response: u.module.response };
            kit.log.event('scan', `unit ${u.unit} ${u.label} (${u.module.request}/${u.module.response})`);
            let result: UnitHealth;
            try {
              result = await withModuleRequests(engine, unit.request, unit.response, (send) =>
                readUnitHealth(unit, (pdu) => classify(() => send(unit.request, unit.response, pdu, healthRequestOptions(pdu)))),
              8000);
            } catch (e) {
              if (e instanceof HealthReadOnlyViolation) throw e;
              result = { ...unit, reachable: false, identity: {}, faults: { status: 'no answer', count: null, dtcs: [], notes: [], raw: [] }, issues: [{ request: '-', answer: (e as Error).message }] };
            }
            results.push(result);
            next++;
            const faults = faultDtcs(result.faults);
            const others = result.faults.dtcs.length - faults.length;
            kit.log.event(result.reachable ? 'result' : 'warn', `unit ${u.unit}: ${result.reachable ? `${result.faults.status}, ${faults.length} fault(s)${faults.length ? ` (${faults.map((d) => udsDtcText(d)).join(', ')})` : ''}${others ? `; ${others} listed entries without a fault bit (not faults)` : ''}` : 'not reachable'}`, {
              ...(result.faults.notes.length ? { notes: result.faults.notes } : {}),
            });
            if (engine.session?.isClosed) throw new Error('the adapter connection closed');
          }
          // The summary goes into this connection's uploaded log.
          for (const r of results.filter((x) => x.reachable && x.faults.dtcs.length)) {
            recordDiag('app', 'health-unit', {
              unit: r.unit, label: r.label, status: r.faults.status, listMask: r.faults.listMask,
              faults: faultDtcs(r.faults).map((d) => `${udsDtcLabel(d)}:${d.statusHex}`),
              notFaults: r.faults.dtcs.length - faultDtcs(r.faults).length, notes: r.faults.notes,
            });
          }
        } finally {
          refused.push(...lock.refused());
          lock.release();
        }
      });
    } catch (e) {
      if (e instanceof HealthReadOnlyViolation) throw e;
      kit.log.event('warn', `unit reads: ${(e as Error).message}${next < units.length ? ' — reconnecting' : ''}`);
    }
  }
  for (const u of units.slice(next)) {
    results.push({ unit: u.unit, label: u.label, request: u.module.request, response: u.module.response, reachable: false, identity: {}, faults: { status: 'no answer', count: null, dtcs: [], notes: [], raw: [] }, issues: [{ request: '-', answer: 'not read: the adapter connection could not be re-established' }] });
  }
  return { results, refused, voltage };
}

export async function health(kit: HealthKit): Promise<number> {
  const label = kit.flag('--label', 'snapshot');
  const odometerFlag = kit.flags.has('--odometer') ? Number(kit.flag('--odometer', '')) : undefined;
  if (odometerFlag !== undefined && !(Number.isFinite(odometerFlag) && odometerFlag >= 0)) throw new Error('--odometer takes the odometer reading in km, e.g. --odometer 27000');
  const takenAt = iso();
  const notes: string[] = [];
  const refused: string[] = [];
  let locked = true;

  // Part 1: generic OBD-II, the app's full scan on a connection that searches with 0100.
  kit.log.event('scan', `health snapshot "${label}": read-only (OBD-II reads, 19 fault reads, 22 identity reads only)`);
  let adapter: string | null = null;
  let voltage: string | null = null;
  const obd = await kit
    .withEngine('obd-search', async (engine) => {
      adapter = engine.adapter.profile?.label ?? engine.adapter.identity ?? null;
      voltage = engine.adapter.voltage ?? null;
      const lock = lockHealth(engine);
      try {
        if (!engine.ecus.length) return obdSection(null, []);
        const scan = await engine.fullScan((s) => {
          if (s.state !== 'running') kit.log.event(s.state === 'failed' ? 'warn' : 'result', `${s.label}: ${s.finding ?? s.state}`);
        });
        await reReadMissing(kit, engine, scan);
        const section = obdSection(scan, engine.ecus);
        recordDiag('app', 'health-obd', {
          mil: section.mil, stored: section.dtcs.stored.codes.map((c) => c.code), pending: section.dtcs.pending.codes.map((c) => c.code),
          permanent: section.dtcs.permanent.codes.map((c) => c.code), counters: section.counters,
          failedTests: section.tests.status === 'ok' ? section.tests.value.filter((t) => !t.passed).map((t) => `${t.mid}/${t.tid}=${t.value}`) : section.tests.status,
        });
        return section;
      } finally {
        refused.push(...lock.refused());
        lock.release();
      }
    })
    .catch((e: Error) => {
      if (e instanceof HealthReadOnlyViolation) throw e;
      notes.push(`OBD-II part not read: ${e.message}`);
      kit.log.event('warn', `OBD-II part: ${e.message}`);
      return obdSection(null, []);
    });

  // Part 2: UDS fault memory of every unit, on the native coding connection (one physical module at a time).
  const { units, from } = unitList(kit);
  notes.push(`unit list: ${from}`);
  kit.log.event('scan', `UDS fault memory of ${units.length} unit(s) (${from})`);
  let unitResults: UnitHealth[] = [];
  try {
    const r = await readUnits(kit, units);
    unitResults = r.results;
    refused.push(...r.refused);
    voltage ??= r.voltage;
  } catch (e) {
    if (e instanceof HealthReadOnlyViolation) {
      locked = false;
      notes.push(`STOPPED: ${e.message}`);
    } else notes.push(`UDS part not read: ${(e as Error).message}`);
  }

  const snapshot: HealthSnapshot = {
    schema: HEALTH_SCHEMA,
    label,
    takenAt,
    finishedAt: iso(),
    odometer: chooseOdometer(obd, odometerFlag),
    car: { vin: obd.vin.status === 'ok' ? obd.vin.value : null, adapter, voltage, synthetic: kit.synthetic() },
    obd,
    units: unitResults,
    notReachable: unitResults.filter((u) => !u.reachable).map((u) => ({ unit: u.unit, label: u.label, request: u.request })),
    readOnly: { locked, refused },
    notes,
  };
  mkdirSync(kit.logDir, { recursive: true, mode: 0o700 });
  const base = join(kit.logDir, `health-${labelSlug(label)}-${fileStamp(takenAt)}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(`${base}.md`, healthMarkdown(snapshot), { mode: 0o600 });
  for (const line of healthSummary(snapshot)) kit.log.event('result', line);
  kit.log.event('result', 'health snapshot saved', { json: `${base}.json`, markdown: `${base}.md` });
  return locked ? 0 : 1;
}

// ---- log ----------------------------------------------------------------------------------------

/** The marks file `live mark` appends to and a running `live log` follows. */
export const marksFile = (logDir: string) => join(logDir, 'marks.txt');

export function mark(kit: HealthKit, words: string[]): number {
  mkdirSync(kit.logDir, { recursive: true, mode: 0o700 });
  const note = words.join(' ').replace(/[\t\r\n]+/g, ' ').trim();
  appendFileSync(marksFile(kit.logDir), `${iso()}\t${note}\n`);
  kit.log.event('result', `mark written${note ? `: ${note}` : ''}`, { file: marksFile(kit.logDir) });
  return 0;
}

/**
 * Marks for a running log: Enter (optionally after a note) in this terminal, and lines another shell appends to the
 * marks file with `live mark`. Returns the stop.
 */
export async function followMarks(kit: HealthKit, writeMark: (note: string, at?: string) => void): Promise<() => void> {
  let rl: { close(): void } | undefined;
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline');
    const i = createInterface({ input: process.stdin });
    i.on('line', (line) => writeMark(line.trim()));
    rl = i;
  }
  const mf = marksFile(kit.logDir);
  let offset = existsSync(mf) ? statSync(mf).size : 0;
  const pollMarks = setInterval(() => {
    try {
      if (!existsSync(mf)) return;
      const size = statSync(mf).size;
      if (size <= offset) return;
      const fd = openSync(mf, 'r');
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      offset = size;
      for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
        const [at, ...note] = line.split('\t');
        writeMark(note.join(' '), at);
      }
    } catch {
      // A marks file being written: read it next time.
    }
  }, 250);
  return () => {
    clearInterval(pollMarks);
    rl?.close();
  };
}

/** Mode 06 misfire monitors (A1..AD) of the engine ECU: "A2 cyl1 0B=15 0C=11; …", or why not. */
async function misfireSnapshot(engine: OBDCraftEngine): Promise<string> {
  const ctx = engine.ctx;
  const ecu = engine.ecus.find((e) => e.role === 'engine') ?? engine.ecus[0];
  if (!ctx || !ecu) return 'not read (no engine ECU)';
  const support = await ctx.runner.execute({ service: 0x06, params: [0xa0], purpose: 'monitor', expectEcus: [ecu.id], maxAttempts: 2 });
  const r = support.ecus[ecu.id];
  if (r?.status !== 'ok') return 'not supported (06 A0 not answered)';
  const mids = bitmapPids(0xa0, r.payload.slice(2, 6)).filter((m) => m >= 0xa1 && m <= 0xad);
  if (!mids.length) return 'not supported (no misfire monitors listed)';
  const parts: string[] = [];
  for (const mid of mids) {
    const rec = await ctx.runner.execute({ service: 0x06, params: [mid], purpose: 'monitor', expectEcus: [ecu.id], maxAttempts: 2 });
    const a = rec.ecus[ecu.id];
    if (a?.status !== 'ok') {
      parts.push(`${hx(mid)} not read`);
      continue;
    }
    const { tests } = decodeMode06Records(MODE06, a.payload.slice(1));
    parts.push(`${hx(mid)}${mid === 0xa1 ? ' all' : ` cyl${mid - 0xa1}`} ${tests.map((t) => `${t.tid}=${t.value}`).join(' ')}`);
  }
  return parts.join('; ');
}

export async function liveLog(kit: HealthKit): Promise<number> {
  const scenarioName = kit.flag('--scenario', '');
  if (!scenarioName) throw new Error('log needs --scenario <A-F|name>, e.g. log --scenario D --fast');
  const scenario = scenarioOf(scenarioName);
  const fast = kit.flags.has('--fast') || (scenario.fast && !kit.flags.has('--pids'));
  const requested = kit.flags.has('--pids') ? parsePidList(kit.flag('--pids', '')) : [...(fast ? FAST_PIDS : DEFAULT_PIDS)];
  const minutes = kit.flags.has('--minutes') ? Number(kit.flag('--minutes', '')) : undefined;
  if (minutes !== undefined && !(minutes > 0)) throw new Error('--minutes takes a positive number, e.g. --minutes 3');
  mkdirSync(kit.logDir, { recursive: true, mode: 0o700 });
  const startedAt = iso();
  const file = join(kit.logDir, `log-${labelSlug(scenario.id)}-${fileStamp(startedAt)}.csv`);

  return kit.withEngine('obd-search', async (engine) => {
    const lock = lockHealth(engine);
    try {
      const ecu = engine.ecus.find((e) => e.role === 'engine') ?? engine.ecus[0];
      if (!ecu) throw new Error('the engine ECU did not answer OBD-II: start the engine (or switch the ignition on) and try again');
      const supported = new Set([...ecu.pids].filter((p) => p % 0x20 !== 0));
      const { use, unsupported } = selectPids(requested, supported, fast);
      if (!use.length) throw new Error(`none of the requested PIDs is supported by ${ecu.id}`);
      const columns = columnsFor(use);
      const head = [
        csvMeta('scenario', scenario.id),
        csvMeta('title', scenario.title),
        csvMeta('how', scenario.how),
        csvMeta('started', startedAt),
        csvMeta('ecu', ecu.id),
        csvMeta('synthetic', kit.synthetic() ? 'yes (fake bridge / simulator: not a real car)' : 'no'),
        csvMeta('pids', use.map(hx).join(',')),
        csvMeta('unsupported', unsupported.length ? `${unsupported.map(hx).join(',')} (not reported supported by the ECU: not logged)` : 'none'),
      ];
      if (supported.has(0x33) && !use.includes(0x33)) {
        const baro = (await engine.ctx!.runner.execute({ service: 0x01, params: [0x33], purpose: 'scan', expectEcus: [ecu.id], maxAttempts: 2 })).ecus[ecu.id];
        if (baro?.status === 'ok' && baro.payload[2] !== undefined) head.push(csvMeta('baro_kpa', String(baro.payload[2])));
      }
      head.push(csvMeta('misfire-start', await misfireSnapshot(engine)));
      writeFileSync(file, `${[...head, csvHeader(columns)].join('\n')}\n`, { mode: 0o600 });
      kit.log.event('result', `logging scenario ${scenario.id} (${scenario.title}) to ${file}`, { pids: use.map(hx).join(','), unsupported: unsupported.map(hx).join(',') });
      kit.log.event('result', `${minutes ? `stops after ${minutes} min or ` : ''}Ctrl-C to stop; Enter (optionally after a note) writes a MARK; from another shell: npm run live -- mark <note>`);

      const t0 = performance.now();
      let samples = 0;
      const write = (row: LogRow) => appendFileSync(file, `${csvRow(columns, row)}\n`);
      const keys = new Set(columns.map((c) => c.key));
      const off = engine.on((e) => {
        if (e.type !== 'readings') return;
        const values: Record<string, number | null> = {};
        for (const r of e.readings as Reading[]) {
          if (!keys.has(r.key) || (r.ecu !== ecu.id && values[r.key] !== undefined)) continue;
          if (r.ecu === ecu.id || values[r.key] === undefined) values[r.key] = r.state === 'ok' ? r.value : null;
        }
        if (!Object.keys(values).length) return;
        samples++;
        write({ t: performance.now() - t0, time: iso(), type: 'sample', values });
      });
      const writeMark = (note: string, at = iso()) => {
        write({ t: performance.now() - t0, time: at, type: 'MARK', note, values: {} });
        kit.log.event('result', `MARK${note ? ` "${note}"` : ''}`);
      };

      const stopMarks = await followMarks(kit, writeMark);

      let stop: () => void = () => {};
      const stopped = new Promise<string>((resolve) => {
        stop = () => resolve('stopped');
        process.once('SIGINT', () => resolve('Ctrl-C'));
        if (minutes) setTimeout(() => resolve(`${minutes} min elapsed`), minutes * 60_000);
        engine.on((e) => e.type === 'disconnected' && resolve(`adapter disconnected (${e.reason})`));
      });
      await engine.startLive({ pids: use });
      const why = await stopped;
      stop();
      stopMarks();
      await engine.stopLive();
      off();
      kit.log.event('result', `log stopped: ${why}`);
      const end = engine.session?.isClosed ? 'not read (adapter disconnected)' : await misfireSnapshot(engine).catch((e: Error) => `not read (${e.message})`);
      appendFileSync(file, `${csvMeta('misfire-end', end)}\n${csvMeta('stopped', `${iso()} (${why})`)}\n`);
      const summary = summarizeLog(parseLogCsv(readFileSync(file, 'utf8')));
      for (const line of summaryLines(summary)) kit.log.event('result', line);
      recordDiag('app', 'health-log', { scenario: scenario.id, file: basename(file), samples, summary: summaryLines(summary) });
      kit.log.event('result', 'log saved', { file, samples });
      return 0;
    } finally {
      lock.release();
    }
  });
}

// ---- compare / report ---------------------------------------------------------------------------

/** Where compare / report write: --out <dir>, else <log-dir>. */
const outDir = (kit: HealthKit) => resolve(kit.flag('--out', '') || kit.logDir);

function readSnapshot(path: string): HealthSnapshot {
  const s = JSON.parse(readFileSync(path, 'utf8')) as HealthSnapshot;
  if (s.schema !== HEALTH_SCHEMA) throw new Error(`${path} is not a health snapshot (schema ${String(s.schema)})`);
  return s;
}

export function compare(kit: HealthKit, args: string[]): number {
  const [a, b] = args;
  if (!a || !b) throw new Error('compare <before.json> <after.json>');
  const before = readSnapshot(a);
  const after = readSnapshot(b);
  const c = compareSnapshots(before, after);
  mkdirSync(outDir(kit), { recursive: true, mode: 0o700 });
  const base = join(outDir(kit), `compare-${labelSlug(before.label)}-${labelSlug(after.label)}-${fileStamp(iso())}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(`${base}.md`, comparisonMarkdown(c), { mode: 0o600 });
  kit.log.event('result', c.verdict);
  kit.log.event('result', `codes gone ${c.gone.length}, new ${c.added.length}, still present ${c.still.length}, not re-read ${c.notReread.length}; permanent still ${c.permanentStill.length}; clear evidence ${c.clearEvidence.length}; software changes ${c.softwareChanges.length}`);
  for (const e of c.clearEvidence) kit.log.event('result', `cleared: ${e}`);
  for (const f of c.clearedNotProven) kit.log.event('warn', `cleared but not proven fixed: ${f.source} ${f.code}`);
  for (const f of c.clearedAndBack) kit.log.event('warn', `cleared and came back (not fixed): ${f.source} ${f.code}`);
  for (const f of c.notReread) kit.log.event('warn', `${f.source} ${f.code}: ${f.status}`);
  for (const s of c.softwareChanges) kit.log.event('result', s);
  kit.log.event('result', 'comparison saved', { json: `${base}.json`, markdown: `${base}.md` });
  return 0;
}

export function report(kit: HealthKit, args: string[]): number {
  const [snapshotPath, ...logs] = args;
  if (!snapshotPath) throw new Error('report <health.json> [log.csv ...]');
  const s = readSnapshot(snapshotPath);
  // Re-analysed from the stored status bytes: an old snapshot's 19 02 FF entries without a fault bit drop out here.
  for (const line of healthSummary(s)) kit.log.event('result', line);
  const raw = healthFindings(s);
  const sources = [basename(snapshotPath)];
  let synthetic = s.car.synthetic;
  for (const path of logs) {
    const file = parseLogCsv(readFileSync(path, 'utf8'));
    const summary = summarizeLog(file);
    raw.push(...logFindings(summary, file.meta.title ?? scenarioOf(file.scenario).title, file.meta.started));
    sources.push(basename(path));
    synthetic ||= (file.meta.synthetic ?? '').startsWith('yes');
  }
  // One finding per kind across the logs (e.g. every log's low-rpm retard together).
  const findings = mergeFindings(raw);
  const input = {
    car: kit.flag('--car', 'Skoda Kushaq 1.0 TSI (automatic)'),
    vin: s.car.vin,
    odometer: s.odometer.km !== null ? `${s.odometer.km} km (${s.odometer.source})` : 'not recorded',
    takenAt: s.takenAt,
    sources,
    findings,
    synthetic,
    readOnly: s.readOnly.locked && !s.readOnly.refused.length,
  };
  mkdirSync(outDir(kit), { recursive: true, mode: 0o700 });
  const base = join(outDir(kit), `report-${labelSlug(s.label)}-${fileStamp(iso())}`);
  writeFileSync(`${base}.md`, reportMarkdown(input), { mode: 0o600 });
  writeFileSync(`${base}.html`, reportHtml(input), { mode: 0o600 });
  const count = (section: string) => findings.filter((f) => f.section === section).length;
  kit.log.event('result', `report: ${count('confirmed')} confirmed, ${count('suspicious')} suspicious, ${count('normal')} normal`);
  for (const f of findings.filter((x) => x.section !== 'normal')) kit.log.event('result', `[${f.section}] ${f.severity}: ${f.title}`);
  kit.log.event('result', 'report saved', { markdown: `${base}.md`, html: `${base}.html` });
  return 0;
}
