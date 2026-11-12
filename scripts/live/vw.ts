/**
 * VW measuring values of the live kit (scripts/live.ts): `vwread`, `vwread --sweep`, `vwlog`. The table, decoding and
 * read-only guard are in src/domain/health/vwmeasure.ts; this file puts them on the bridge.
 *
 * Read-only by construction, three times over: every PDU passes `assertVwRequest` (22 of one identifier, 3E, 10 01 /
 * 10 03 only) before it is handed over; the adapter's send policy is locked with the health lock
 * (`enterHealthReadOnly`) AND the scan's read-only lock (`enterReadOnly`: 22, 3E, 10 01 / 10 03 only) for the whole
 * connection; and a request either refuses stops the run (HealthReadOnlyViolation) instead of being retried.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ModuleRequest, withModuleRequests } from '@obdcraft/coding';
import { toHex, type OBDCraftEngine } from '@obdcraft/obd-core';
import { csvHeader, csvMeta, csvRow, type LogRow } from '../../src/domain/health/livelog.ts';
import { HealthReadOnlyViolation } from '../../src/domain/health/readonly.ts';
import type { UdsAnswer } from '../../src/domain/health/uds.ts';
import {
  assertVwRequest, decodeMeasure, defaultLogMeasures, didExists, hex4, nrcText, parseDidSpec, parseSweepRange, selectMeasures,
  VW_MODULES, type VwMeasure, type VwUnit, vwColumns, vwValues,
} from '../../src/domain/health/vwmeasure.ts';
import { classify, followMarks, type HealthKit, lockHealth } from './health.ts';

const iso = () => new Date().toISOString();
/** How long a 22 read keeps listening after 7F 22 78 response-pending. */
const PENDING_POLL_MS = 3000;
const fileStamp = (s: string) => s.replace(/[:.]/g, '-');

/**
 * `--dids`: a list (`39C0,02:1234`), or `@<file>`: a vwsweep JSON (its `found` DIDs, on its unit) or any text whose
 * lines start with `22xxxx` (a raw sweep), read as DIDs of the first --unit.
 */
function didsOf(kit: HealthKit, unit: VwUnit): { unit: VwUnit; did: number }[] {
  if (!kit.flags.has('--dids')) return [];
  const spec = kit.flag('--dids', '');
  if (!spec.startsWith('@')) return parseDidSpec(spec, unit);
  const text = readFileSync(spec.slice(1), 'utf8');
  try {
    const sweep = JSON.parse(text) as { unit?: VwUnit; found?: { did: string }[] };
    if (Array.isArray(sweep.found)) return parseDidSpec(sweep.found.map((x) => x.did).join(','), sweep.unit ?? unit);
  } catch {
    // not JSON: a raw list
  }
  return parseDidSpec([...text.matchAll(/^\s*22([0-9A-F]{4})\b/gim)].map((m) => m[1]).join(','), unit);
}

function unitsOf(kit: HealthKit): VwUnit[] {
  const text = kit.flag('--unit', '01');
  const units = text.split(',').map((u) => u.trim().padStart(2, '0'));
  for (const u of units) if (u !== '01' && u !== '02') throw new Error(`--unit takes 01 (engine) and/or 02 (gearbox), got "${u}"`);
  return [...new Set(units)] as VwUnit[];
}

/** One read-only connection: both policy locks held, `ask` sends one checked PDU and classifies the answer. */
async function withVwReads<T>(
  kit: HealthKit, engine: OBDCraftEngine, first: VwUnit,
  work: (ask: (unit: VwUnit, pdu: number[]) => Promise<UdsAnswer>) => Promise<T>,
): Promise<T> {
  const policy = engine.link?.policy;
  if (!policy) throw new Error('no adapter link to lock');
  const health = lockHealth(engine);
  const scanLock = policy.enterReadOnly();
  try {
    const m = VW_MODULES[first];
    return await withModuleRequests(engine, m.request, m.response, async (send: ModuleRequest) => {
      const ask = (unit: VwUnit, pdu: number[]) => {
        assertVwRequest(pdu);
        const mod = VW_MODULES[unit];
        // The engine answers most 22 reads with 7F 22 78 first and the value ~150 ms later: keep the adapter
        // listening (silent 3E 80 polls, allowed by both locks) for up to PENDING_POLL_MS after a 78.
        return classify(() => send(mod.request, mod.response, pdu, pdu[0] === 0x22 ? { pendingPollMs: PENDING_POLL_MS } : {}));
      };
      if (kit.flags.has('--extended')) {
        for (const u of new Set([first, ...unitsOf(kit)])) {
          const a = await ask(u, [0x10, 0x03]);
          kit.log.event(a.kind === 'ok' ? 'result' : 'warn', `unit ${u} extended session (10 03): ${a.kind === 'ok' ? 'entered' : describe(a)}`);
        }
      }
      return work(ask);
    }, 8000);
  } finally {
    const refused = health.refused();
    if (refused.length) kit.log.event('warn', `send policy refused: ${refused.join('; ')}`);
    scanLock();
    health.release();
  }
}

function describe(a: UdsAnswer): string {
  switch (a.kind) {
    case 'ok': return toHex(a.bytes, ' ');
    case 'nrc': return nrcText(a.code);
    case 'truncated': return `truncated answer (${a.partial.length} of ${a.declared ?? '?'} bytes)`;
    case 'pending': return 'response pending, no final answer';
    case 'no-reply': return `no reply${a.adapter ? ` (${a.adapter})` : ''}`;
    case 'lost': return `lost: ${a.error}`;
  }
}

/** The data bytes of a positive 22 answer, or why there are none (the echoed DID must match). */
function dataOf(a: UdsAnswer, did: number): { data: number[] } | { why: string } {
  if (a.kind !== 'ok') return { why: describe(a) };
  const b = a.bytes;
  if (b[0] !== 0x62 || b[1] !== did >> 8 || b[2] !== (did & 0xff)) return { why: `unexpected answer ${toHex(b, ' ')}` };
  return { data: b.slice(3) };
}

interface ReadResult {
  unit: VwUnit;
  did: string;
  label: string;
  confidence: string;
  source: string;
  answer: string;
  hex?: string;
  decoded?: string;
  values?: Record<string, number | null>;
  supported: boolean | null;
}

// ---- vwread -------------------------------------------------------------------------------------

export async function vwread(kit: HealthKit): Promise<number> {
  if (kit.flags.has('--sweep')) return sweep(kit);
  const units = unitsOf(kit);
  const extra = didsOf(kit, units[0]!);
  const measures = selectMeasures(units, extra, kit.flags.has('--only'));
  if (!measures.length) throw new Error('nothing to read: no candidates for that unit and no --dids');
  const takenAt = iso();
  kit.log.event('scan', `vwread: ${measures.length} identifier(s) on unit(s) ${[...new Set(measures.map((m) => m.unit))].join(', ')} — read-only (22 only)`);
  const results: ReadResult[] = [];
  let next = 0;
  for (let attempt = 0; attempt < 3 && next < measures.length; attempt++) {
    try {
      await kit.withEngine('diagnostic-can', (engine) => withVwReads(kit, engine, measures[next]!.unit, async (ask) => {
        while (next < measures.length) {
          const m = measures[next]!;
          const a = await ask(m.unit, [0x22, m.did >> 8, m.did & 0xff]);
          const d = dataOf(a, m.did);
          const head = `${m.unit} ${hex4(m.did)} ${m.label} [${m.confidence}]`;
          const r: ReadResult = { unit: m.unit, did: hex4(m.did), label: m.label, confidence: m.confidence, source: m.source, answer: describe(a), supported: a.kind === 'nrc' && a.code === 0x31 ? false : didExists(a) ? true : null };
          if ('data' in d) {
            const dec = decodeMeasure(m, d.data);
            Object.assign(r, { hex: toHex(d.data, ' '), decoded: dec.text, values: dec.values });
            kit.log.event(dec.lengthMismatch ? 'warn' : 'result', `${head}: ${toHex(d.data, ' ') || '(no data)'} → ${dec.text}`);
          } else {
            kit.log.event(r.supported === false ? 'note' : 'warn', `${head}: ${r.supported === false ? 'NOT SUPPORTED (NRC 31)' : d.why}`);
          }
          results.push(r);
          next++;
          if (engine.session?.isClosed) throw new Error('the adapter connection closed');
        }
      }));
    } catch (e) {
      if (e instanceof HealthReadOnlyViolation) throw e;
      kit.log.event('warn', `vwread: ${(e as Error).message}${next < measures.length ? ' — reconnecting' : ''}`);
    }
  }
  const ok = results.filter((r) => r.hex !== undefined).length;
  const no = results.filter((r) => r.supported === false).length;
  kit.log.event('result', `vwread: ${ok} answered, ${no} not supported (NRC 31), ${results.length - ok - no} other, ${measures.length - results.length} not read`);
  mkdirSync(kit.logDir, { recursive: true, mode: 0o700 });
  const file = join(kit.logDir, `vwread-${fileStamp(takenAt)}.json`);
  writeFileSync(file, `${JSON.stringify({ takenAt, synthetic: kit.synthetic(), results }, null, 2)}\n`, { mode: 0o600 });
  kit.log.event('result', 'vwread saved', { file });
  return results.length === measures.length ? 0 : 1;
}

// ---- sweep --------------------------------------------------------------------------------------

async function sweep(kit: HealthKit): Promise<number> {
  const units = unitsOf(kit);
  if (units.length !== 1) throw new Error('--sweep reads one unit at a time: --unit 01 or --unit 02');
  const unit = units[0]!;
  const range = kit.flag('--sweep', '');
  const dids = parseSweepRange(range);
  const takenAt = iso();
  mkdirSync(kit.logDir, { recursive: true, mode: 0o700 });
  const file = join(kit.logDir, `vwsweep-${unit}-${range.toUpperCase()}-${fileStamp(takenAt)}.json`);
  kit.log.event('scan', `sweep unit ${unit} ${hex4(dids[0]!)}-${hex4(dids.at(-1)!)}: ${dids.length} identifier(s), 22 reads only`);
  const found: { did: string; answer: string; hex?: string; length?: number }[] = [];
  const silent: string[] = [];
  let notSupported = 0;
  let next = 0;
  const save = () => writeFileSync(file, `${JSON.stringify({ takenAt, unit, range, synthetic: kit.synthetic(), read: next, of: dids.length, notSupported, noAnswer: silent, found }, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 5 && next < dids.length; attempt++) {
    try {
      await kit.withEngine('diagnostic-can', (engine) => withVwReads(kit, engine, unit, async (ask) => {
        while (next < dids.length) {
          const did = dids[next]!;
          const a = await ask(unit, [0x22, did >> 8, did & 0xff]);
          if (a.kind === 'nrc' && a.code === 0x31) notSupported++;
          else if (didExists(a)) {
            const d = dataOf(a, did);
            const entry = { did: hex4(did), answer: describe(a), ...('data' in d ? { hex: toHex(d.data, ' '), length: d.data.length } : {}) };
            found.push(entry);
            kit.log.event('result', `${unit} ${hex4(did)}: ${'data' in d ? `${d.data.length} byte(s) ${entry.hex}` : entry.answer}`);
          } else silent.push(`${hex4(did)} ${describe(a)}`);
          next++;
          if (next % 32 === 0) {
            kit.log.event('note', `sweep ${next}/${dids.length}: ${found.length} found`);
            save();
          }
          if (engine.session?.isClosed) throw new Error('the adapter connection closed');
        }
      }));
    } catch (e) {
      if (e instanceof HealthReadOnlyViolation) throw e;
      kit.log.event('warn', `sweep: ${(e as Error).message}${next < dids.length ? ' — reconnecting' : ''}`);
    }
  }
  save();
  kit.log.event('result', `sweep: ${found.length} identifier(s) answer, ${notSupported} NRC 31, ${silent.length} no clear answer, ${dids.length - next} not read`, { file });
  return next === dids.length ? 0 : 1;
}

// ---- vwlog --------------------------------------------------------------------------------------

export async function vwlog(kit: HealthKit): Promise<number> {
  const units = unitsOf(kit);
  const extra = didsOf(kit, units[0]!);
  let measures = extra.length ? selectMeasures(units, extra, true) : defaultLogMeasures(units);
  if (!measures.length) throw new Error('nothing to log: pass --dids 39C0,… (or a unit with default log candidates)');
  const minutes = kit.flags.has('--minutes') ? Number(kit.flag('--minutes', '')) : undefined;
  if (minutes !== undefined && !(minutes > 0)) throw new Error('--minutes takes a positive number, e.g. --minutes 10');
  const label = kit.flag('--label', 'drive');
  mkdirSync(kit.logDir, { recursive: true, mode: 0o700 });
  const startedAt = iso();
  const file = join(kit.logDir, `vwlog-${label.replace(/[^a-z0-9-]+/gi, '-')}-${fileStamp(startedAt)}.csv`);

  let why = '';
  const stop = (reason: string) => {
    why ||= reason;
  };
  process.once('SIGINT', () => stop('Ctrl-C'));
  const timer = minutes ? setTimeout(() => stop(`${minutes} min elapsed`), minutes * 60_000) : undefined;

  let columns: ReturnType<typeof vwColumns> = [];
  let started = false;
  let samples = 0;
  let t0 = performance.now();
  const write = (row: LogRow) => appendFileSync(file, `${csvRow(columns, row)}\n`);
  let stopMarks: () => void = () => {};
  let failures = 0;

  while (!why && failures < 5) {
    try {
      await kit.withEngine('diagnostic-can', (engine) => withVwReads(kit, engine, measures[0]!.unit, async (ask) => {
        if (!started) {
          // Probe once: drop what the unit does not have; a raw-only DID gets one column per byte it answered.
          const unsupported: string[] = [];
          const kept: VwMeasure[] = [];
          for (const m of measures) {
            const a = await ask(m.unit, [0x22, m.did >> 8, m.did & 0xff]);
            const d = dataOf(a, m.did);
            if ('data' in d) {
              kept.push(m.fields.length ? m : { ...m, fields: d.data.slice(0, 16).map((_, i) => ({ key: `b${i}`, type: 'u8' as const, scale: 1, unit: '' })) });
              kit.log.event('result', `${m.unit} ${hex4(m.did)} ${m.label}: ${toHex(d.data, ' ')} → ${decodeMeasure(m, d.data).text}`);
            } else {
              unsupported.push(`${m.unit}:${hex4(m.did)} (${d.why})`);
              kit.log.event('warn', `${m.unit} ${hex4(m.did)} ${m.label}: ${d.why} — not logged`);
            }
          }
          if (!kept.length) throw new NothingToLog('none of the identifiers answered: nothing to log');
          measures = kept;
          columns = vwColumns(measures);
          const head = [
            csvMeta('scenario', `vw-${label}`),
            csvMeta('title', `VW measuring values (${label})`),
            csvMeta('started', startedAt),
            csvMeta('synthetic', kit.synthetic() ? 'yes (fake bridge / simulator: not a real car)' : 'no'),
            csvMeta('dids', measures.map((m) => `${m.unit}:${hex4(m.did)} ${m.label} [${m.confidence}]`).join('; ')),
            csvMeta('unsupported', unsupported.length ? unsupported.join('; ') : 'none'),
          ];
          writeFileSync(file, `${[...head, csvHeader(columns)].join('\n')}\n`, { mode: 0o600 });
          t0 = performance.now();
          started = true;
          stopMarks = await followMarks(kit, (note, at = iso()) => {
            write({ t: performance.now() - t0, time: at, type: 'MARK', note, values: {} });
            kit.log.event('result', `MARK${note ? ` "${note}"` : ''}`);
          });
          kit.log.event('result', `logging ${measures.length} identifier(s) to ${file}`);
          kit.log.event('result', `${minutes ? `stops after ${minutes} min or ` : ''}Ctrl-C to stop; Enter (optionally after a note) writes a MARK; from another shell: npm run live -- mark <note>`);
        }
        // One row per cycle through the identifiers.
        while (!why) {
          const values: Record<string, number | null> = {};
          for (const m of measures) {
            const a = await ask(m.unit, [0x22, m.did >> 8, m.did & 0xff]);
            const d = dataOf(a, m.did);
            if ('data' in d) Object.assign(values, vwValues(m, decodeMeasure(m, d.data)));
            if (engine.session?.isClosed) throw new Error('the adapter connection closed');
          }
          samples++;
          write({ t: performance.now() - t0, time: iso(), type: 'sample', values });
          failures = 0;
          if (samples % 20 === 0) kit.log.event('note', `${samples} cycles, ${((performance.now() - t0) / samples / 1000).toFixed(2)} s per cycle`);
        }
      }));
    } catch (e) {
      if (e instanceof HealthReadOnlyViolation) throw e;
      if (e instanceof NothingToLog) {
        stop(e.message);
        break;
      }
      failures++;
      kit.log.event('warn', `vwlog: ${(e as Error).message}${why ? '' : ' — reconnecting'}`);
    }
  }
  if (timer) clearTimeout(timer);
  stopMarks();
  if (!why) why = `gave up after ${failures} lost connection(s)`;
  if (started) appendFileSync(file, `${csvMeta('stopped', `${iso()} (${why})`)}\n`);
  kit.log.event('result', `vwlog stopped: ${why}`, started ? { file, samples } : {});
  return started ? 0 : 1;
}

/** vwlog's stop when no identifier answered (not worth reconnecting for). */
class NothingToLog extends Error {}
