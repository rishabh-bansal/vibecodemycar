/**
 * Live kit CLI: drives the car in real time through the BLE bridge (tools/live/elm-bridge) or the fake bridge
 * (scripts/live/fake-bridge.ts), both a raw ELM327 byte pipe on TCP.
 *
 *   node scripts/live.ts <command> [args] [--host 127.0.0.1] [--port 35000] [--log-dir ~/.obdcraft/live]
 *                                    [--upload | --no-upload]
 *                                    [--model <brand/model/variant>] [--year <n>]
 *                                    [--frame-mode full|trim-zero|fc-alt|stpx]   (how writes hand frames to the adapter)
 *
 *   status                               bridge reachable? adapter answers ATI / ATRV; local store summary
 *   raw <AT or hex>...                   one command per argument, through the session (policy-checked; --unsafe skips)
 *   identify                             adapter profile, BCM + cluster identity, VIN presence (never the VIN)
 *   read <unit|req:resp> <did>           one 22 read on an addressed module (unit 09, 17, bcm, cluster, 70E:778 …)
 *   features                             the car on the bus (or --model, then no bus) and what the app offers for it
 *   inspect <unit|all>                   the app's read-only module inventory (runInspect) of a unit; `all` = scan
 *   scan [--deep] [--units 09,17]        read-only full car scan: every unit address probed, every fitted unit read,
 *                                        mapped to <log-dir>/scans/<started>-<VIN>.json and .md, then summarised
 *   apply <featureId> <settingId|value:n> [--yes]   preview (module, DID, before → after, owned mask), confirm, write
 *   restore <backupId> [--yes]           preview and put a backup's original back (the app's restore)
 *   frametest --yes [--modes full,trim-zero,fc-alt,stpx]
 *                                        writes ONLY the BCM (70E/778) F198 workshop code: for each frame mode and an
 *                                        8th frame byte of 00 and 5A, write (real writer: session, unit-default code
 *                                        31347, markers off), read back, compare; then restores the original with the
 *                                        best mode. Table on stdout, report in <log-dir>/frametest-<iso>.json.
 *                                        Needs F198 readable: the owner's BCM keeps it write-only (22 F198 → 7F 22 31),
 *                                        so there it stops at once, writes nothing, and points to `repair`
 *   echo                                 echo check: two harmless 8-byte BCM F198 reads with adapter echo on; says
 *                                        whether the adapter received each byte as sent (nothing is written)
 *   repair [did ...] [--yes]             puts the stray BCM bytes back to factory (0A69, 0A76, 055C, 0A5E): read,
 *                                        preview, confirm, write (trim-zero, with the F199/F198 markers: the BCM
 *                                        refuses coding without the F198 workshop login, 7F 2E 24), read back
 *   --no-markers                         writes (apply/restore/repair) skip the F199/F198 coding markers
 *                                        (`--with-markers` is accepted and ignored: markers are the default)
 *   backups                              lists backups in the local store
 *   tail [file]                          follows the newest session log (or `file`) as it grows
 *
 * Evidence (strictly read-only: the send policy is locked to OBD-II reads, 19 fault reads and 22 identity reads):
 *   health [--label baseline|after|<text>] [--odometer <km>] [--units 01,09,17]
 *                                        one evidence snapshot: OBD-II full scan + every reachable unit's UDS fault
 *                                        memory → <log-dir>/health-<label>-<iso>.json and .md
 *   log --scenario <A-F|name> [--fast] [--pids 0C,0D,…] [--minutes N]
 *                                        live data to <log-dir>/log-<scenario>-<iso>.csv; Enter writes a MARK row
 *   mark [note]                          appends a mark the running `log` picks up (from another shell)
 *   compare <before.json> <after.json>   codes gone / new / still, clear evidence, software changes
 *   vwread [--unit 01|02|01,02] [--dids 39C0,02:1234] [--only] [--extended]
 *                                        VW measuring values over UDS 22: the candidate table of
 *                                        src/domain/health/vwmeasure.ts (+ --dids), raw hex and decoded value each,
 *                                        NRC 31 = not supported → <log-dir>/vwread-<iso>.json
 *   vwread --sweep 2000-20FF [--unit 01] every DID of the range read once (22 only); which answer →
 *                                        <log-dir>/vwsweep-<unit>-<range>-<iso>.json
 *   vwlog [--dids …] [--unit …] [--minutes N] [--label <text>] [--extended]
 *                                        cycles the DIDs to <log-dir>/vwlog-<label>-<iso>.csv (marks as `log`)
 *   report <health.json> [log.csv …] [--car <text>]   the advisor's page → <log-dir>/report-<label>-<iso>.md and .html
 *                                        (compare and report: --out <dir> writes there instead of <log-dir>; both
 *                                        re-analyse old snapshots, counting only UDS entries with a fault bit)
 *
 * features / inspect / scan / apply / restore run the app's own engine: WebBluetoothLink over the TCP bridge, the
 * CodingController with the session store's deps, recipes from src/data/app-data.json and features.ts for the car.
 * Their experiment, journal and connection-log records are then uploaded to the private cloud log through the app's
 * outbox (scripts/live/cloud.ts) — unless --no-upload, the run is on the fake bridge or the VIN is one of the kit's
 * synthetic ones. A command whose bridge connection fails records and uploads nothing.
 *
 * Every TX/RX line and coding event streams to stdout (ms since start and since the previous line) and is appended
 * as NDJSON to <log-dir>/<sessionISO>.ndjson. Backups and experiments persist in <log-dir>/db/ (scripts/live/store.ts).
 * VINs are never printed or logged: VIN replies are redacted on the wire and only a short hash is shown.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeModule, readModuleDid } from '@obdcraft/coding';
import { ElmSession, OBDCraftEngine, PolicyError, SafetyPolicy, shareableProfile, toHex, type WireEvent } from '@obdcraft/obd-core';
import { TcpTransport } from '../packages/obd-core/src/transport/tcp.ts';
import { SCAN_TARGETS } from '../src/domain/catalog/modules.ts';
import { color, LiveLog, maskVins } from './live/stream.ts';
import { prepareCloudStorage } from './live/cloud.ts';
import { fakeBridgeOn } from './live/fake-marker.ts';
import { openLiveStore, type LiveStore } from './live/store.ts';

// ---- arguments ---------------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  '--host', '--port', '--log-dir', '--timeout', '--model', '--year', '--units', '--frame-mode', '--modes',
  '--label', '--odometer', '--scenario', '--pids', '--minutes', '--car', '--out', '--dids', '--unit', '--sweep',
]);
const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (VALUE_FLAGS.has(a)) flags.set(a, argv[++i] ?? '');
  else if (a.startsWith('--')) flags.set(a, true);
  else positional.push(a);
}
const flag = (name: string, def: string) => {
  const v = flags.get(name);
  return typeof v === 'string' ? v : def;
};
const expandHome = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const host = flag('--host', '127.0.0.1');
const port = Number(flag('--port', '35000'));
const logDir = resolve(expandHome(flag('--log-dir', '~/.obdcraft/live')));
const timeoutMs = Number(flag('--timeout', '5000'));
/** Uploading is the default (`--upload` only says so); `--no-upload` keeps everything local and wins over it. */
const noUpload = flags.has('--no-upload');
const modelFlag = flags.has('--model') ? flag('--model', '') : undefined;
const yearFlag = flags.has('--year') ? Number(flag('--year', '')) : undefined;
const [command = 'help', ...rest] = positional;
type FrameMode = import('../src/domain/coding/types.ts').WriteFrameMode;
const FRAME_MODES: readonly FrameMode[] = ['full', 'trim-zero', 'fc-alt', 'stpx'];
const asFrameMode = (value: string, from: string): FrameMode => {
  if ((FRAME_MODES as readonly string[]).includes(value)) return value as FrameMode;
  throw new Error(`${from}: unknown frame mode "${value}" (${FRAME_MODES.join(', ')})`);
};
/** `--frame-mode`: how every write of this command hands its frames to the adapter (default full). */
const frameModeFlag = flags.has('--frame-mode') ? asFrameMode(flag('--frame-mode', ''), '--frame-mode') : undefined;
/** `--no-markers`: writes of this command don't stamp the F199/F198 coding markers (repairs leave no workshop code). */
const markersFlag = flags.has('--no-markers') ? false : undefined;

// ---- shared helpers ----------------------------------------------------------------------------

/** Diagnostic units by number or name; anything else must be an explicit `req:resp` pair. */
const UNIT_ALIASES: Record<string, string> = { bcm: '09', cluster: '17', gateway: '19', abs: '03', hvac: '08', mib: '5F' };
const EXTRA_UNITS: Record<string, { request: string; response: string }> = {
  '01': { request: '7E0', response: '7E8' },
  '02': { request: '7E1', response: '7E9' },
};

function resolveModule(spec: string): { request: string; response: string; label: string } {
  const pair = /^([0-7][0-9A-F]{2}):([0-7][0-9A-F]{2})$/i.exec(spec);
  if (pair) return { request: pair[1]!.toUpperCase(), response: pair[2]!.toUpperCase(), label: spec.toUpperCase() };
  const unit = (UNIT_ALIASES[spec.toLowerCase()] ?? spec).toUpperCase().padStart(2, '0');
  const known = SCAN_TARGETS[unit]?.module ?? EXTRA_UNITS[unit];
  if (!known) throw new Error(`unknown unit "${spec}": use a unit number (${Object.keys(SCAN_TARGETS).join(', ')}, 01, 02) or req:resp`);
  return { ...known, label: `unit ${unit} ${SCAN_TARGETS[unit]?.label ?? ''}`.trim() };
}

function parseDid(s: string): number {
  if (!/^[0-9A-F]{4}$/i.test(s)) throw new Error(`DID must be 4 hex digits, got "${s}"`);
  return Number.parseInt(s, 16);
}

const vinHash = (vin: string) => createHash('sha256').update(vin).digest('hex').slice(0, 12);
const printable = (bytes: number[]) => {
  const t = String.fromCharCode(...bytes).replace(/\0+$/, '');
  return /^[\x20-\x7e]+$/.test(t) ? t : null;
};

class Usage extends Error {}

/**
 * A connection log for this command's adapter traffic, uploaded as the app's are (it may reach the car). It starts
 * only once the bridge connection is up (`start`): a failed connect records nothing and uploads nothing. Traffic
 * seen before that is printed as it happens and held, then recorded first.
 */
function connectionLog(store: LiveStore, state: RunState, log: LiveLog) {
  const early: WireEvent[] = [];
  let recorder: { wire: (e: WireEvent) => void; stop: (reason: string) => Promise<void> } | undefined;
  return {
    wire: (e: WireEvent) => {
      log.wire(e);
      if (recorder) recorder.wire(e);
      else early.push(e);
    },
    async start() {
      recorder = (await loadEngine()).recordConnection(store);
      state.touchedCar = true;
      for (const e of early.splice(0)) recorder.wire(e);
    },
    stop: async (reason: string) => {
      await recorder?.stop(reason);
    },
  };
}

async function withSession<T>(log: LiveLog, store: LiveStore, state: RunState, work: (session: ElmSession) => Promise<T>): Promise<T> {
  const transport = new TcpTransport({ host, port });
  try {
    await transport.open();
  } catch (e) {
    throw new Error(`${(e as Error).message} — is the bridge running? (npm run live:bridge, or npm run live:fake)`);
  }
  log.event('connect', `bridge ${host}:${port}`);
  const recorder = connectionLog(store, state, log);
  await recorder.start();
  const session = new ElmSession(transport, { onWire: recorder.wire });
  try {
    return await work(session);
  } finally {
    session.dispose();
    await transport.close();
    await recorder.stop('command finished');
  }
}

/**
 * The app's connection: ATZ, echo off, identify, automatic protocol, physical module binding (diagnostic-can). With
 * `startup: 'obd-search'` it is the app's OBD-II connection instead (0100 search, ECU discovery, live data); an engine
 * that does not answer then leaves a connection with no ECUs rather than an error.
 */
async function withEngine<T>(
  log: LiveLog, store: LiveStore, state: RunState, work: (engine: OBDCraftEngine) => Promise<T>,
  startup: 'diagnostic-can' | 'obd-search' = 'diagnostic-can',
): Promise<T> {
  const recorder = connectionLog(store, state, log);
  const engine = new OBDCraftEngine({ startup, silentCar: 'diagnostic-can', onWire: recorder.wire });
  try {
    await engine.connect(new TcpTransport({ host, port }));
  } catch (e) {
    // Nothing was recorded, so nothing of a failed connect is uploaded (now or by a later command).
    await engine.disconnect().catch(() => {});
    throw new Error(`${(e as Error).message} — is the bridge running and the adapter ready?`);
  }
  await recorder.start();
  if (frameModeFlag && engine.link) engine.link.frameMode = frameModeFlag;
  const adapter = engine.adapter;
  log.event('adapter', adapter?.profile?.label ?? 'adapter', { voltage: adapter?.voltage, protocol: engine.link?.protocol.name });
  try {
    return await work(engine);
  } finally {
    await engine.disconnect().catch(() => {});
    await recorder.stop('command finished');
  }
}

/** Reads the VIN with RX wire text hidden; reports only presence and a hash. */
async function readVin(log: LiveLog, engine: OBDCraftEngine, module: { request: string; response: string }) {
  return log.redacted(async () => {
    try {
      const bytes = await readModuleDid(engine, module.request, module.response, 0xf190, 8000);
      const vin = String.fromCharCode(...bytes.filter((b) => b !== 0 && b !== 0xaa));
      return { ok: true, length: vin.length, plausible: /^[A-HJ-NPR-Z0-9]{17}$/.test(vin), hash: vinHash(vin) };
    } catch (e) {
      return { ok: false, error: maskVins((e as Error).message) };
    }
  });
}

// ---- commands ----------------------------------------------------------------------------------

async function status(log: LiveLog, store: LiveStore, state: RunState): Promise<number> {
  const backups = await store.backups.list();
  log.event('result', 'local store', { file: store.file, backups: backups.length, experiments: await store.db.experiments.count() });
  return withSession(log, store, state, async (session) => {
    const ati = await session.send('ATI', 2000);
    const rv = await session.send('ATRV', 2000);
    const ok = ati.status === 'ok';
    log.event(ok ? 'result' : 'error', ok ? 'adapter answers' : 'adapter did not answer ATI', {
      identity: ati.lines[0] ?? null,
      voltage: rv.lines[0] ?? null,
      atiStatus: ati.status,
    });
    return ok ? 0 : 1;
  });
}

async function raw(log: LiveLog, store: LiveStore, state: RunState, commands: string[]): Promise<number> {
  if (!commands.length) throw new Usage('raw needs at least one command, e.g. raw ATI ATRV 0100');
  const unsafe = flags.has('--unsafe');
  const policy = new SafetyPolicy();
  const normalized = commands.map((c) => c.replace(/\s+/g, '').toUpperCase());
  // Refuse up front: a half-sent list is worse than none.
  for (const c of normalized) {
    try {
      policy.check(c, { family: 'can11' });
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      if (!unsafe) {
        log.event('error', `refused by the send policy: ${c} — ${e.message} (pass --unsafe to send anyway)`);
        return 2;
      }
      log.event('warn', `--unsafe: sending ${c} despite the send policy (${e.message})`);
    }
  }
  return withSession(log, store, state, async (session) => {
    let failures = 0;
    for (const c of normalized) {
      const r = await session.send(c, timeoutMs);
      if (r.status !== 'ok') failures++;
      log.event(r.status === 'ok' ? 'result' : 'error', `${c} -> ${r.status}`, {
        lines: r.lines,
        statuses: r.statuses,
        ms: Math.round(r.durationMs),
      });
    }
    return failures ? 1 : 0;
  });
}

/**
 * Echo check: does the adapter receive a full 8-byte frame intact over Bluetooth? With echo on (ATE1) the adapter
 * repeats each line it received; two harmless BCM reads of F198 go out as full 8-byte single frames (the length
 * byte 03 makes the BCM ignore bytes 5-8), one with a 00 and one with a non-zero 8th byte. Echo intact + byte 8
 * stored wrong on writes = the adapter changes the byte after receiving it. Nothing is written to the car.
 */
async function echo(log: LiveLog, store: LiveStore, state: RunState): Promise<number> {
  const frames = ['0322F19800000000', '0322F19811223344'];
  return withSession(log, store, state, async (session) => {
    let bad = 0;
    const setup = ['ATE1', 'ATH1', 'ATS0', 'ATSP6', 'ATCAF0', 'ATSH70E', 'ATCRA778'];
    for (const c of setup) {
      const r = await session.send(c, timeoutMs);
      if (r.status !== 'ok') log.event('warn', `${c} -> ${r.status}`, { lines: r.lines });
    }
    for (const f of frames) {
      const r = await session.send(f, timeoutMs);
      const echoed = r.rxRaw.split(/[\r\n]+/).map((l) => l.replace(/\s+/g, '').toUpperCase()).find((l) => l.length > 0 && !l.startsWith('SEARCHING')) ?? '';
      const intact = r.echoSeen;
      if (!intact) bad++;
      log.event(intact ? 'result' : 'error', `echo ${f}: ${intact ? 'intact' : `CHANGED -> ${echoed || '(nothing)'}`}`, {
        sent: f,
        echoed,
        byte8Sent: f.slice(14),
        answer: r.lines,
        status: r.status,
        ms: Math.round(r.durationMs),
      });
    }
    for (const c of ['ATE0', 'ATCAF1', 'ATCRA', 'ATS1']) await session.send(c, timeoutMs);
    log.event(
      bad ? 'error' : 'result',
      bad
        ? 'the adapter did not receive the frame as sent: the Bluetooth path or its input buffer changes it'
        : 'the adapter received every byte as sent: a wrong 8th byte on the car happens inside the adapter',
    );
    return bad ? 1 : 0;
  });
}

async function identify(log: LiveLog, store: LiveStore, state: RunState): Promise<number> {
  return withEngine(log, store, state, async (engine) => {
    const profile = engine.adapter?.profile;
    if (profile) log.event('result', 'adapter profile', shareableProfile(profile) as unknown as Record<string, unknown>);
    for (const unit of ['09', '17']) {
      const m = resolveModule(unit);
      try {
        const id = await probeModule(engine, m.request, m.response);
        log.event('result', m.label, {
          part: id.part, software: id.software, hardware: id.hardware, odxFile: id.odxFile, odxVersion: id.odxVersion, notes: id.notes,
        });
      } catch (e) {
        log.event('error', `${m.label}: ${(e as Error).message}`);
      }
    }
    const vin = await readVin(log, engine, resolveModule('17'));
    log.event(vin.ok ? 'result' : 'warn', 'VIN (cluster F190) — value never shown', vin);
    return 0;
  });
}

async function read(log: LiveLog, store: LiveStore, state: RunState, args: string[]): Promise<number> {
  const [unit, didText] = args;
  if (!unit || !didText) throw new Usage('read <unit|req:resp> <did>, e.g. read 09 0600');
  const module = resolveModule(unit);
  const did = parseDid(didText);
  return withEngine(log, store, state, async (engine) => {
    if (did === 0xf190) {
      const vin = await readVin(log, engine, module);
      log.event(vin.ok ? 'result' : 'error', `${module.label} F190 (VIN) — value never shown`, vin);
      return vin.ok ? 0 : 1;
    }
    try {
      const data = await readModuleDid(engine, module.request, module.response, did, timeoutMs);
      // A DID other than F190 may still carry the VIN among other bytes: its hex would show it unmasked.
      const text = String.fromCharCode(...data.map((b) => (b >= 0x20 && b < 0x7f ? b : 0x20)));
      const carriesVin = maskVins(text) !== text;
      log.event('result', `${module.label} ${didText.toUpperCase()}`, {
        length: data.length,
        ...(carriesVin
          ? { hex: '[hidden: the answer contains a VIN]' }
          : { hex: toHex(data, ''), ...(printable(data) ? { ascii: printable(data) } : {}) }),
      });
      return 0;
    } catch (e) {
      log.event('error', `${module.label} ${didText.toUpperCase()}: ${(e as Error).message}`);
      return 1;
    }
  });
}

async function backups(log: LiveLog, store: LiveStore): Promise<number> {
  const list = await store.backups.list();
  if (!list.length) log.event('result', `no backups in ${store.file}`);
  for (const b of list) {
    log.event('result', b.id, {
      createdAt: b.createdAt, featureId: b.featureId, settingId: b.settingId, operation: b.operation, status: b.status,
      target: `${b.module.request} ${b.did}${b.steps ? ` (+${b.steps.length - 1} parts)` : ''}`, before: b.before, intended: b.intended,
    });
  }
  return 0;
}

// ---- the app's engine: features, inspect, apply, restore ---------------------------------------

type Engine = typeof import('./live/engine.ts');
const loadEngine = (): Promise<Engine> => import('./live/engine.ts');

/** What an engine command touched: the upload decision depends on it. */
interface RunState {
  synthetic: boolean;
  touchedCar: boolean;
}

/** 0 when the run ended in one of the two outcomes that mean "it worked" (verified, observed-match). */
function exitFor(events: readonly { type: string; outcome?: string }[]): number {
  const outcome = events.findLast((e) => e.type === 'outcome')?.outcome;
  return outcome === 'verified' || outcome === 'observed-match' ? 0 : 1;
}

async function confirm(log: LiveLog, question: string): Promise<boolean> {
  if (flags.has('--yes')) return true;
  if (!process.stdin.isTTY) {
    log.event('warn', 'no terminal to confirm on: re-run with --yes once the plan above is checked');
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(color.bold(`${question} [y/N] `))).trim());
  } finally {
    rl.close();
  }
}

async function features(log: LiveLog, store: LiveStore, state: RunState): Promise<number> {
  const engine = await loadEngine();
  let sel: import('../src/domain/catalog/types.ts').CarSelection | undefined;
  if (modelFlag) {
    sel = engine.selectionFromFlag(modelFlag, yearFlag);
    log.event('result', `car from --model: ${sel.brand} ${sel.model} ${sel.variant} ${sel.year} (${sel.cluster} cluster) — bus not read`);
  } else {
    const rig = await engine.openLink(log, store, { host, port }, frameModeFlag, markersFlag);
    state.touchedCar = true;
    try {
      const id = await engine.identifyCar(rig.link, log, { year: yearFlag });
      state.synthetic ||= id.synthetic;
      sel = id.sel;
    } finally {
      await rig.close();
    }
    if (!sel) throw new Usage('the car could not be told from its modules: pass --model, e.g. --model kushaq or --model skoda/kushaq/monte-carlo');
  }
  const items = engine.featuresFor(sel);
  const codable = items.filter((f) => f.tier !== 'unavailable');
  log.event('result', `${codable.length} codable of ${items.length} listed`);
  for (const f of codable) {
    const settings = f.settings.map((s) => s.id).join(', ');
    log.event('result', `${f.id} [${f.tier}]`, {
      name: f.name,
      writes: engine.targetOf(f),
      settings,
      ...(f.scalar ? { value: `value:<n> ${f.scalar.min}…${f.scalar.max}${f.scalar.unit ? ` ${f.scalar.unit}` : ''}` } : {}),
    });
  }
  return 0;
}

async function inspect(log: LiveLog, store: LiveStore, state: RunState, args: string[]): Promise<number> {
  const unit = (args[0] ?? '').toUpperCase();
  if (!unit) throw new Usage('inspect <unit|all>, e.g. inspect 09, inspect all');
  const engine = await loadEngine();
  const { SCAN_TARGETS: targets } = await import('../src/domain/catalog/modules.ts');
  const resolved = unit === 'ALL' ? 'all' : (UNIT_ALIASES[unit.toLowerCase()] ?? unit).toUpperCase().padStart(2, '0');
  const first = resolved === 'all' ? targets['09'] : targets[resolved];
  if (!first) throw new Usage(`inspect: unknown unit "${args[0]}" (${Object.keys(targets).join(', ')}, all)`);
  const rig = await engine.openLink(log, store, { host, port }, frameModeFlag, markersFlag);
  state.touchedCar = true;
  try {
    const id = await engine.identifyCar(rig.link, log, { model: modelFlag, year: yearFlag });
    state.synthetic ||= id.synthetic;
    // The scan reads the unit whatever the car; the selection only labels the record.
    const car = id.sel ?? engine.selectionFromFlag('kushaq');
    if (!id.sel) log.event('warn', 'car not told from its modules: the record is labelled as a Kushaq (pass --model to label it)');
    const events = await engine.runCodingSession(
      rig,
      store,
      log,
      { kind: 'inspect', car, module: first.module, unit: resolved, label: resolved === 'all' ? 'all control units' : first.label },
      await engine.pairedFingerprint(logDir, id.vin),
    );
    return exitFor(events);
  } finally {
    await rig.close();
  }
}

/**
 * The full car scan: the app's `inspect all` path (discovery of every known unit address, each fitted unit's read
 * plan, the car map), read-only by construction. The map is saved under <log-dir>/scans and summarised here; the
 * run's experiment record (with the map) is uploaded like every other session.
 */
async function scan(log: LiveLog, store: LiveStore, state: RunState): Promise<number> {
  const deep = flags.has('--deep');
  const units = flags.has('--units')
    ? flag('--units', '')
        .split(',')
        .map((u) => (UNIT_ALIASES[u.trim().toLowerCase()] ?? u.trim()).toUpperCase())
        .filter(Boolean)
    : undefined;
  const { selectScanUnits } = await import('../src/domain/scan/units.ts');
  if (units?.some((u) => !selectScanUnits([u]).length)) {
    const known = selectScanUnits().flatMap((u) => [u.unit, ...u.aliases]);
    throw new Usage(`scan --units: unknown unit in "${units.join(',')}" (known: ${known.join(', ')})`);
  }
  const engine = await loadEngine();
  const rig = await engine.openLink(log, store, { host, port }, frameModeFlag, markersFlag);
  state.touchedCar = true;
  try {
    const id = await engine.identifyCar(rig.link, log, { model: modelFlag, year: yearFlag });
    state.synthetic ||= id.synthetic;
    // The scan reads whatever is fitted; the selection only labels the record.
    const car = id.sel ?? engine.selectionFromFlag('kushaq');
    log.event('scan', `full car scan${deep ? ' with the deep sweep' : ''}${units ? ` of units ${units.join(', ')}` : ''}: read-only (22 reads only)`);
    const events = await engine.runCodingSession(
      rig,
      store,
      log,
      {
        kind: 'inspect',
        car,
        module: { request: '70E', response: '778' },
        unit: 'all',
        label: 'Full car scan',
        scan: { deep, ...(units ? { units } : {}) },
      },
      await engine.pairedFingerprint(logDir, id.vin),
    );
    const mapped = events.findLast((e) => e.type === 'car-map');
    if (mapped?.type === 'car-map') {
      const files = engine.saveCarMap(logDir, mapped.map);
      log.event('result', 'car map saved', files);
      for (const line of engine.carMapSummary(mapped.map)) log.event('result', line);
    }
    return exitFor(events);
  } finally {
    await rig.close();
  }
}

async function apply(log: LiveLog, store: LiveStore, state: RunState, args: string[]): Promise<number> {
  const [featureId, setting] = args;
  if (!featureId || !setting) throw new Usage('apply <featureId> <settingId|value:n> [--yes]');
  const engine = await loadEngine();
  const { fingerprintVin } = await import('../src/domain/vin.ts');
  const rig = await engine.openLink(log, store, { host, port }, frameModeFlag, markersFlag);
  state.touchedCar = true;
  try {
    const id = await engine.identifyCar(rig.link, log, { model: modelFlag, year: yearFlag });
    state.synthetic ||= id.synthetic;
    if (!id.sel) throw new Usage('the car could not be told from its modules: pass --model, e.g. --model kushaq');
    const item = engine.findFeature(id.sel, featureId);
    if (!item) throw new Usage(`"${featureId}" is not listed for this car (npm run live -- features)`);
    if (item.tier === 'unavailable') throw new Usage(`"${featureId}" is not codable on this car: ${item.statusLabel}`);
    const settingId = /^value:/.test(setting) || item.settings.some((s) => s.id === setting) ? setting : undefined;
    if (!settingId) throw new Usage(`setting "${setting}" is not offered: ${item.settings.map((s) => s.id).join(', ') || 'value:<n>'}`);
    const fingerprint = id.vin ? await fingerprintVin(id.vin) : undefined;
    const plan = await engine.planApply(rig.link, item, settingId, { backups: await store.backups.list(), fingerprint });
    engine.printPlan(log, plan, markersFlag !== false);
    if (plan.every((w) => w.noop)) {
      log.event('result', 'the car already holds this setting: nothing to write');
      return 0;
    }
    if (!(await confirm(log, `Write ${plan.filter((w) => !w.noop).length} block(s) shown above to the car?`))) {
      log.event('warn', 'not confirmed: nothing was written');
      return 2;
    }
    rig.fence(engine.writeFence(plan, log));
    const events = await engine.runCodingSession(
      rig,
      store,
      log,
      { kind: 'apply', car: id.sel, feature: item, settingId },
      await engine.pairedFingerprint(logDir, id.vin),
    );
    return exitFor(events);
  } finally {
    await rig.close();
  }
}

async function restore(log: LiveLog, store: LiveStore, state: RunState, args: string[]): Promise<number> {
  const [backupId] = args;
  if (!backupId) throw new Usage('restore <backupId> [--yes] (ids: npm run live -- backups)');
  const backup = await store.backups.get(backupId);
  if (!backup) throw new Usage(`no backup "${backupId}" in ${store.file}`);
  const engine = await loadEngine();
  const rig = await engine.openLink(log, store, { host, port }, frameModeFlag, markersFlag);
  state.touchedCar = true;
  try {
    const id = await engine.identifyCar(rig.link, log, { model: modelFlag, year: yearFlag });
    state.synthetic ||= id.synthetic;
    const plan = await engine.planRestore(rig.link, backup);
    engine.printPlan(log, plan, markersFlag !== false);
    if (!(await confirm(log, `Put the original back as shown above (${backup.featureName})?`))) {
      log.event('warn', 'not confirmed: nothing was written');
      return 2;
    }
    rig.fence(engine.writeFence(plan, log));
    const events = await engine.runCodingSession(rig, store, log, { kind: 'restore', backup }, await engine.pairedFingerprint(logDir, id.vin));
    return exitFor(events);
  } finally {
    await rig.close();
  }
}

/**
 * The frame test (src/infra/link/frame-test.ts): writes only the BCM's F198 workshop code, once per frame mode and
 * 8th-byte value, reads it back each time, and restores the original with the best mode. Needs --yes: it writes.
 */
/**
 * Bytes on the owner's Kushaq BCM (2Q0937089D, 70E/778) that earlier writes left wrong because the clone adapter
 * changed the 8th byte of full CAN frames. Only these bytes change; every other byte (features the owner set) stays
 * as the car holds it. Each value is what the car held before any coding (the first recorded "before" of that DID).
 */
const BCM_REPAIRS: readonly { did: string; length: number; bytes: Record<number, string>; why: string }[] = [
  { did: '0A69', length: 7, bytes: { 2: '00' }, why: 'byte 2 stored A0/30 by lane-change blink writes (factory 00)' },
  { did: '0A76', length: 4, bytes: { 0: '00', 3: '00' }, why: 'sunroof write: 06 in byte 0 and stray 30 in byte 3 (factory all 00)' },
  { did: '055C', length: 16, bytes: { 2: '00', 9: '00' }, why: 'stray 30 in byte 2 and A0 in byte 9 from the fog-light write (factory 00)' },
  { did: '0A5E', length: 5, bytes: { 2: '00' }, why: 'byte 2 stored A0 by the 2026-10-23 blinks write (factory 00)' },
];

/**
 * Puts the BCM repairs back: reads each DID, sets only the repair bytes to their factory value, asks, writes it
 * with the real writer (unit-default code, the F199/F198 workshop markers unless --no-markers, `trim-zero` unless
 * --frame-mode says otherwise), reads back and compares. DIDs already at the factory value are skipped.
 * `repair [did ...]` limits the list. Markers are on by default: the BCM answers a coding write without the F198
 * workshop-code login first with 7F 2E 24 (live 2026-11-09). `--with-markers` is an accepted no-op.
 */
async function repair(log: LiveLog, store: LiveStore, state: RunState, only: string[]): Promise<number> {
  const wanted = only.map((d) => d.toUpperCase());
  const list = BCM_REPAIRS.filter((r) => !wanted.length || wanted.includes(r.did));
  if (!list.length) throw new Usage(`repair: unknown DID (${BCM_REPAIRS.map((r) => r.did).join(', ')})`);
  const engine = await loadEngine();
  const mode = frameModeFlag ?? 'trim-zero';
  const markers = !flags.has('--no-markers');
  const markerText = markers
    ? 'with the F199/F198 workshop markers (the BCM refuses coding without the F198 login: 7F 2E 24)'
    : 'no markers (--no-markers: the BCM may refuse with 7F 2E 24)';
  const rig = await engine.openLink(log, store, { host, port }, mode, markers ? undefined : false);
  state.touchedCar = true;
  const module = { request: '70E', response: '778' };
  let failed = 0;
  try {
    const id = await engine.identifyCar(rig.link, log, { model: modelFlag, year: yearFlag });
    state.synthetic ||= id.synthetic;
    if (id.bcmPart && id.bcmPart !== '2Q0937089D') {
      log.event('error', `these repairs are for BCM 2Q0937089D; this car's BCM is ${id.bcmPart}: nothing written`);
      return 2;
    }
    for (const r of list) {
      const before = await rig.link.readDid(module, r.did);
      if (before.kind !== 'ok') {
        log.event('error', `${r.did}: could not read it first (${before.kind}): skipped`);
        failed++;
        continue;
      }
      const current = before.bytes.toUpperCase();
      const offsets = Object.keys(r.bytes).map(Number);
      if (current.length / 2 !== r.length) {
        log.event('error', `${r.did}: holds ${current.length / 2} bytes, the owner's BCM holds ${r.length}: skipped`, { current });
        failed++;
        continue;
      }
      const target = (current.match(/../g) ?? []).map((b, i) => r.bytes[i] ?? b).join('');
      const diff = offsets.flatMap((i) => (current.slice(i * 2, i * 2 + 2) === r.bytes[i] ? [] : [`byte ${i}: ${current.slice(i * 2, i * 2 + 2)}→${r.bytes[i]}`]));
      if (!diff.length) {
        log.event('result', `${r.did}: repair bytes already at factory values (${current})`);
        continue;
      }
      log.event('plan', `repair 70E:778 DID ${r.did} (${mode}, ${markerText})`, { before: current, after: target, changes: diff, why: r.why });
      if (!(await confirm(log, `Write ${r.did} = ${target}?`))) {
        log.event('warn', `${r.did}: not written`);
        continue;
      }
      const result = await rig.link.writeDid(module, r.did, target, {
        securityPassword: '31347',
        passwordSource: 'unit-default',
        originalBytes: current,
        onPending: () => {},
        // The BCM answers 7F 2E 24 to a coding write without the F198 workshop-code login first: markers by default.
        markers,
        frameMode: mode,
      });
      const read = await rig.link.readDid(module, r.did);
      const stored = read.kind === 'ok' ? read.bytes.toUpperCase() : undefined;
      const ok = stored === target;
      if (!ok) failed++;
      log.event(ok ? 'result' : 'error', `${r.did}: ${ok ? 'REPAIRED' : 'NOT repaired'}`, {
        write: result.kind,
        stored: stored ?? `(${read.kind})`,
        expected: target,
      });
    }
    return failed ? 1 : 0;
  } finally {
    await rig.close();
  }
}

async function frametest(log: LiveLog, store: LiveStore, state: RunState): Promise<number> {
  if (!flags.has('--yes')) {
    log.event('error', 'frametest writes the BCM (70E) F198 workshop code up to 9 times and restores it: re-run with --yes');
    return 2;
  }
  const modes = flags.has('--modes') ? flag('--modes', '').split(',').map((m) => asFrameMode(m.trim(), '--modes')) : undefined;
  const { runFrameTest } = await import('../src/infra/link/frame-test.ts');
  const engine = await loadEngine();
  const rig = await engine.openLink(log, store, { host, port });
  state.touchedCar = true;
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const file = join(logDir, `frametest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try {
    const id = await engine.identifyCar(rig.link, log, { model: modelFlag, year: yearFlag });
    state.synthetic ||= id.synthetic;
    if (modes?.includes('stpx') && !rig.link.adapter?.stpx) log.event('warn', 'stpx skipped: the adapter is not a confirmed STN chip (STI)');
    log.event('coding', `frame test on ${rig.link.adapter?.firmware ?? 'adapter'}: writes F198 on 70E only`, { file });
    const report = await runFrameTest(rig.link, {
      ...(modes ? { modes } : {}),
      // Saved as it grows: the original F198 is on disk before the first write.
      onProgress: (r) => writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 }),
      onNote: (text) => log.event('note', text),
    });
    const rows = [
      ['mode', '8th', 'sent', 'write', 'stored', '8th stored', 'result'],
      ...report.trials.map((t) => [
        t.mode, t.value, t.sent, t.write, t.stored ?? `(${t.read})`, t.byte8 ?? '-',
        t.match ? 'OK' : t.landed ? 'CORRUPTED' : 'NOT LANDED',
      ]),
      ...(report.restore
        ? [[`restore (${report.restore.mode})`, (report.original ?? '').slice(4, 6), report.original ?? '', report.restore.write,
            report.restore.stored ?? '?', report.restore.stored?.slice(4, 6) ?? '-', report.restore.exact ? 'RESTORED' : 'NOT RESTORED']]
        : []),
    ];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? '').length)));
    for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i]!)).join('  '));
    for (const line of report.findings) log.event(report.restore?.exact === false || report.stopped ? 'warn' : 'result', line);
    log.event('result', 'frame test report saved', { file, original: report.original });
    return report.restore?.exact ? 0 : 1;
  } finally {
    await rig.close();
  }
}

/** OBDCRAFT_LOG_ENDPOINT names a log Worker other than the real one the app uploads to. */
async function otherLogWorker(): Promise<boolean> {
  const override = process.env.OBDCRAFT_LOG_ENDPOINT?.trim();
  if (!override) return false;
  const { logEndpoint } = await import('../src/infra/cloud/config.ts');
  const hostOf = (url: string | undefined): string | undefined => {
    if (!url) return undefined;
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const real = hostOf(logEndpoint());
  const other = hostOf(override);
  // An override that isn't a URL is treated as the real log, so synthetic records stay out of it.
  if (!other) return false;
  return other !== real;
}

/** Queues and uploads what this command recorded, through the app's outbox. */
async function upload(log: LiveLog, store: LiveStore, state: RunState): Promise<void> {
  if (!state.touchedCar) return;
  if (noUpload) {
    log.event('upload', '--no-upload: records kept locally only', { store: store.file });
    return;
  }
  // Synthetic runs (the fake bridge, the simulator, the kit's synthetic VINs) never reach the real log. Only an
  // explicit OBDCRAFT_LOG_ENDPOINT that is not the real log Worker (a local `wrangler dev`) may receive them.
  if (state.synthetic && !(await otherLogWorker())) {
    const n = await (await loadEngine()).excludeFromUpload(store);
    log.event('upload', `synthetic run (fake bridge / simulator): ${n} records kept out of the real log for good`, { store: store.file });
    return;
  }
  await store.flush();
  try {
    const { openCloud } = await import('./live/cloud.ts');
    const report = await (await openCloud(() => store.db)).sync();
    log.event(report.failed || !report.registered ? 'warn' : 'upload', `cloud log: ${report.uploaded} uploaded, ${report.queued} queued, ${report.failed} failed`, report as unknown as Record<string, unknown>);
  } catch (e) {
    log.event('warn', `upload did not run: ${(e as Error).message} (records stay queued locally; the next command retries)`);
  }
}

/** Follows a session log: prints each NDJSON line compactly as it is appended. */
async function tail(file?: string): Promise<number> {
  let path = file ? resolve(expandHome(file)) : '';
  if (!path) {
    const logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.ndjson')).sort() : [];
    if (!logs.length) throw new Usage(`no session logs in ${logDir}`);
    path = join(logDir, logs[logs.length - 1]!);
  }
  console.log(color.dim(`following ${path} (Ctrl-C to stop)`));
  let offset = 0;
  let partial = '';
  const pump = () => {
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      try {
        const o = JSON.parse(line) as { ms: number; dt: number; kind: string; dir?: string; text?: string; type?: string; message?: string; data?: unknown };
        const stamp = color.dim(`${`+${o.ms}`.padStart(7)}ms ${`Δ${o.dt}`.padStart(6)}ms`);
        if (o.kind === 'wire') {
          const tag = o.dir === 'tx' ? color.cyan('TX') : o.dir === 'rx' ? color.green('RX') : color.yellow('ST');
          console.log(`${stamp} ${tag} ${(o.text ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`);
        } else {
          const extra = o.data && Object.keys(o.data).length ? ` ${color.dim(JSON.stringify(o.data))}` : '';
          console.log(`${stamp} ${color.magenta(`[${o.type}]`)} ${o.message}${extra}`);
        }
      } catch {
        console.log(line);
      }
    }
  };
  pump();
  watchFile(path, { interval: 100 }, pump);
  await new Promise(() => {});
  return 0;
}

/** The evidence commands' view of this CLI (scripts/live/health.ts). Store and state are absent for the offline ones. */
function healthKit(log: LiveLog, store: LiveStore | undefined, state: RunState | undefined): import('./live/health.ts').HealthKit {
  return {
    log,
    logDir,
    flags,
    flag,
    withEngine: (startup, work) => {
      if (!store || !state) throw new Error('this command does not connect to the bridge');
      return withEngine(log, store, state, work, startup);
    },
    synthetic: () => state?.synthetic ?? false,
  };
}

const HELP = `usage: node scripts/live.ts <command> [args] [--host 127.0.0.1] [--port 35000] [--log-dir ~/.obdcraft/live] [--upload | --no-upload]
  read-only:  status | raw <AT or hex>... [--unsafe] | identify | read <unit|req:resp> <did> | features | inspect <unit|all>
              scan [--deep] [--units 09,17]   (full car scan → <log-dir>/scans/<started>-<VIN>.json and .md)
  writes:     apply <featureId> <settingId|value:n> [--yes] | restore <backupId> [--yes]
              frametest --yes [--modes full,trim-zero,fc-alt,stpx]   (BCM F198 only; restores it; needs F198 readable)
  --frame-mode full|trim-zero|fc-alt|stpx   how writes hand CAN frames to the adapter (default full)
  --no-markers                              writes don't stamp the F199/F198 workshop markers
  adapter:    echo   (does the adapter receive 8-byte frames intact? reads only)
              repair [0A69 0A76 055C 0A5E] [--yes] [--no-markers]   (BCM back to factory values; trim-zero, with markers)
  evidence (read-only):
              health [--label baseline|after|<text>] [--odometer <km>] [--units 01,09,17]
              log --scenario <A-F|name> [--fast] [--pids 0C,0D,...] [--minutes N] | mark [note]
              compare <before.json> <after.json> | report <health.json> [log.csv ...] [--car <text>]   [--out <dir>]
              vwread [--unit 01|02|01,02] [--dids 39C0,02:1234] [--only] [--extended] | vwread --sweep 2000-20FF [--unit 01]
              vwlog [--dids 39C0,...] [--unit 01] [--minutes N] [--label <text>] [--extended]   (UDS 22 reads only)
  local:      backups | tail [file]
  --model <brand/model/variant> (car override, e.g. kushaq or skoda/kushaq/monte-carlo)  --year <n>
  --timeout <ms> (raw/read, default 5000)   OBDCRAFT_LOG_ENDPOINT=<url> uploads to another log Worker`;

// ---- main --------------------------------------------------------------------------------------

async function main(): Promise<number> {
  if (command === 'help' || flags.has('--help')) {
    console.log(HELP);
    return 0;
  }
  if (command === 'tail') return tail(rest[0]);
  if (command === 'mark' || command === 'compare' || command === 'report') {
    // Local files only: no bridge, no store, nothing uploaded.
    const log = new LiveLog(logDir, command);
    try {
      const evidence = await import('./live/health.ts');
      const kit = healthKit(log, undefined, undefined);
      return command === 'mark' ? evidence.mark(kit, rest) : command === 'compare' ? evidence.compare(kit, rest) : evidence.report(kit, rest);
    } catch (e) {
      log.event('error', (e as Error).message);
      return 64;
    }
  }
  const log = new LiveLog(logDir, command);
  // Before any app module reads localStorage: the cloud credential lives in <log-dir> (never printed).
  prepareCloudStorage(logDir);
  const store = await openLiveStore(logDir);
  // A run on the fake bridge is synthetic from the start: identification may fail or read nothing.
  const state: RunState = { synthetic: fakeBridgeOn(port), touchedCar: false };
  log.event('session', `${command} ${rest.join(' ')}`.trim(), {
    log: log.file,
    upload: noUpload ? 'off' : state.synthetic ? 'not to the real log (fake bridge)' : 'on',
  });
  try {
    switch (command) {
      case 'status': return await status(log, store, state);
      case 'raw': return await raw(log, store, state, rest);
      case 'identify': return await identify(log, store, state);
      case 'read': return await read(log, store, state, rest);
      case 'backups': return await backups(log, store);
      case 'features': return await features(log, store, state);
      case 'inspect': return await inspect(log, store, state, rest);
      case 'scan': return await scan(log, store, state);
      case 'apply': return await apply(log, store, state, rest);
      case 'restore': return await restore(log, store, state, rest);
      case 'frametest': return await frametest(log, store, state);
      case 'echo': return await echo(log, store, state);
      case 'repair': return await repair(log, store, state, rest);
      case 'health': return await (await import('./live/health.ts')).health(healthKit(log, store, state));
      case 'log': return await (await import('./live/health.ts')).liveLog(healthKit(log, store, state));
      case 'vwread': return await (await import('./live/vw.ts')).vwread(healthKit(log, store, state));
      case 'vwlog': return await (await import('./live/vw.ts')).vwlog(healthKit(log, store, state));
      default: throw new Usage(`unknown command "${command}"\n${HELP}`);
    }
  } catch (e) {
    log.event('error', (e as Error).message);
    return e instanceof Usage ? 64 : 1;
  } finally {
    await store.flush();
    await upload(log, store, state);
    await store.flush();
    console.log(color.dim(`log: ${log.file}`));
  }
}

process.exitCode = await main();
// Open handles (fake-indexeddb timers) must not keep a finished command alive.
process.exit(process.exitCode);
