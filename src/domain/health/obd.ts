import type { FullScanResult, Reading } from '@obdcraft/obd-core';
import type { Field } from './uds.ts';
import { dtcMeaning } from './uds.ts';

/**
 * The generic OBD-II half of a health snapshot, built from the engine's full scan (OBDCraftEngine.fullScan: modes 09,
 * 01, 03/07/0A, 02, 06, 08 list, 05). Everything is taken from what the ECUs answered; a value an ECU does not
 * support, or that the adapter did not bring back, is "not supported" / "not read" with the reason — never filled in.
 */

export interface ObdDtc {
  ecu: string;
  code: string;
  meaning: string;
}

export interface ObdDtcList {
  status: 'ok' | 'not supported' | 'incomplete' | 'error';
  codes: ObdDtc[];
}

export interface ObdMonitor {
  name: string;
  status: 'complete' | 'incomplete' | 'not supported';
  continuous: boolean;
}

export interface ObdTest {
  ecu: string;
  mid: string;
  midName: string;
  tid: string;
  tidName: string;
  value: number;
  min: number;
  max: number;
  unit: string | null;
  passed: boolean;
  /** The raw value sits at the end of its range: many ECUs report that before the test has run. */
  saturated: boolean;
  /** misfire cylinder N, misfire (all cylinders), catalyst, oxygen sensor; null for the rest. */
  highlight: string | null;
}

export interface ObdFreezeFrame {
  ecu: string;
  dtc: string;
  meaning: string;
  values: { name: string; value: number | string | null; unit: string | null }[];
}

export interface ObdSection {
  /** False when no ECU answered OBD-II (engine ECU asleep, or the adapter could not reach it). */
  answered: boolean;
  note?: string;
  ecus: { id: string; role: string; name: string | null }[];
  vin: Field<string>;
  calid: Field<string[]>;
  cvn: Field<string[]>;
  ecuName: Field<string[]>;
  mil: Field<boolean>;
  dtcCount: Field<number>;
  monitors: Field<ObdMonitor[]>;
  /** PIDs 21, 30, 31, 4D, 4E, A6: the counters a fault-code clear resets (A6 is the odometer). */
  counters: {
    distanceWithMilKm: Field<number>;
    warmupsSinceClear: Field<number>;
    distanceSinceClearKm: Field<number>;
    minutesWithMil: Field<number>;
    minutesSinceClear: Field<number>;
    odometerKm: Field<number>;
  };
  dtcs: { stored: ObdDtcList; pending: ObdDtcList; permanent: ObdDtcList };
  freezeFrames: ObdFreezeFrame[];
  /** Mode 06 self-test results with their limits. */
  tests: Field<ObdTest[]>;
  testIssues: string[];
  /** Mode 01 PIDs read at snapshot time, per ECU (engine first): the conditions the snapshot was taken in. */
  readings: { ecu: string; pid: string; name: string; value: number | string | null; unit: string | null }[];
}

/** Decoded values rounded for reading (the raw bytes are in the scan records, not in the snapshot). */
export const round = (v: number): number => Math.round(v * 1000) / 1000;
const shown = (r: Reading): number | string | null => r.text ?? (r.value === null ? null : round(r.value));

const notSupported = <T>(why: string): Field<T> => ({ status: 'not supported', why });
const notRead = <T>(why: string): Field<T> => ({ status: 'not read', why });
const ok = <T>(value: T): Field<T> => ({ status: 'ok', value });

/** Which part of the car a mode 06 monitor tests, when it is one the symptoms or the job card care about. */
export function testHighlight(mid: number): string | null {
  if (mid === 0xa1) return 'misfire (all cylinders)';
  if (mid >= 0xa2 && mid <= 0xad) return `misfire cylinder ${mid - 0xa1}`;
  if (mid >= 0x21 && mid <= 0x24) return 'catalyst';
  if (mid >= 0x01 && mid <= 0x10) return 'oxygen sensor';
  return null;
}

function dtcList(list: FullScanResult['dtcs']['stored']): ObdDtcList {
  if (!list) return { status: 'error', codes: [] };
  const codes = list.perEcu.flatMap((e) =>
    e.codes.map((c) => ({ ecu: e.ecu, code: c.code, meaning: dtcMeaning(c.code) })),
  );
  const status: ObdDtcList['status'] =
    list.state === 'codes' || list.state === 'none'
      ? 'ok'
      : list.state === 'unavailable'
        ? 'not supported'
        : list.state === 'incomplete'
          ? 'incomplete'
          : 'error';
  return { status, codes };
}

function engineReading(scan: FullScanResult, engine: string | undefined, key: string): Reading | undefined {
  const all = scan.readings.filter((r) => r.key === key && r.state === 'ok');
  return all.find((r) => r.ecu === engine) ?? all[0];
}

/**
 * Readiness from PID 01: the three continuous monitors from their supported/incomplete flags, the non-continuous
 * ones from the available/incomplete bit lists. Monitors the ECU does not list are not supported.
 */
function monitorsOf(scan: FullScanResult, engine: string | undefined): Field<ObdMonitor[]> {
  const pick = (key: string) => engineReading(scan, engine, key);
  const status01 = pick('monitor_status_mil');
  if (!status01) return notRead('PID 01 (monitor status) not answered');
  const out: ObdMonitor[] = [];
  for (const [name, id] of [
    ['misfire', 'misfire'],
    ['fuel system', 'fuel'],
    ['comprehensive components', 'components'],
  ] as const) {
    const supported = pick(`monitor_status_${id}_supported`)?.value;
    const incomplete = pick(`monitor_status_${id}_incomplete`)?.value;
    out.push({
      name,
      continuous: true,
      status: !supported ? 'not supported' : incomplete ? 'incomplete' : 'complete',
    });
  }
  const available = scan.readings.find(
    (r) => r.key === 'monitor_status_noncontinuous_available' && (r.ecu === engine || !engine),
  );
  const incomplete = scan.readings.find(
    (r) => r.key === 'monitor_status_noncontinuous_incomplete' && (r.ecu === engine || !engine),
  );
  for (const name of available?.setBits ?? []) {
    out.push({
      name,
      continuous: false,
      status: incomplete?.setBits?.includes(name) ? 'incomplete' : 'complete',
    });
  }
  return ok(out);
}

function counter(
  scan: FullScanResult,
  engine: string | undefined,
  key: string,
  pid: string,
  advertised: boolean,
): Field<number> {
  const r = engineReading(scan, engine, key);
  if (r && r.value !== null) return ok(r.value);
  return advertised
    ? notRead(`PID ${pid} advertised but not answered`)
    : notSupported(`PID ${pid} not supported by the ECU`);
}

function infoList(scan: FullScanResult, pid: number, label: string): Field<string[]> {
  const items = scan.identity?.items.filter((i) => i.pid === pid) ?? [];
  if (!scan.identity) return notRead('mode 09 not read');
  if (!items.length) return notSupported(`mode 09 ${label} not supported`);
  const values = items.filter((i) => i.status === 'ok').map((i) => `${i.ecu}: ${i.text ?? i.raw}`);
  return values.length ? ok(values) : notRead(`mode 09 ${label}: ${items.map((i) => i.status).join(', ')}`);
}

/** The OBD-II section of a health snapshot from a full scan. `advertised` = the engine ECU's mode 01 PID list. */
export function obdSection(
  scan: FullScanResult | null,
  ecus: readonly { id: string; role: string; name?: string; pids: ReadonlySet<number> }[],
): ObdSection {
  const engine = ecus.find((e) => e.role === 'engine')?.id ?? ecus[0]?.id;
  const adv = (pid: number) => ecus.some((e) => e.pids.has(pid));
  const none = (why: string) => notRead<never>(why);
  if (!scan || !ecus.length) {
    const why = scan ? 'no ECU answered OBD-II' : 'the OBD-II scan did not run';
    const empty: ObdDtcList = { status: 'error', codes: [] };
    return {
      answered: false,
      note: `${why}: engine ECU asleep (ignition off?) or not reachable through the adapter`,
      ecus: [],
      vin: none(why),
      calid: none(why),
      cvn: none(why),
      ecuName: none(why),
      mil: none(why),
      dtcCount: none(why),
      monitors: none(why),
      counters: {
        distanceWithMilKm: none(why),
        warmupsSinceClear: none(why),
        distanceSinceClearKm: none(why),
        minutesWithMil: none(why),
        minutesSinceClear: none(why),
        odometerKm: none(why),
      },
      dtcs: { stored: empty, pending: empty, permanent: empty },
      freezeFrames: [],
      tests: none(why),
      testIssues: [],
      readings: [],
    };
  }
  const mil = engineReading(scan, engine, 'monitor_status_mil');
  const count = engineReading(scan, engine, 'monitor_status_dtc_count');
  const freezeFrames: ObdFreezeFrame[] = (scan.freeze?.perEcu ?? [])
    .filter((f) => f.state === 'stored' && f.dtc)
    .map((f) => ({
      ecu: f.ecu,
      dtc: f.dtc!.code,
      meaning: dtcMeaning(f.dtc!.code),
      values: f.readings.map((r) => ({ name: r.name, value: shown(r), unit: r.unit })),
    }));
  let tests: Field<ObdTest[]>;
  const testIssues: string[] = [];
  if (!scan.monitors) tests = notRead('mode 06 not read');
  else if (!scan.monitors.applicable) tests = notSupported('mode 06 not used on this protocol');
  else if (!scan.monitors.perEcu.length) tests = notSupported('no ECU lists mode 06 monitors');
  else {
    tests = ok(
      scan.monitors.perEcu.flatMap((e) =>
        e.tests.map((t) => ({
          ecu: e.ecu,
          mid: t.mid,
          midName: t.midName,
          tid: t.tid,
          tidName: t.tidName,
          value: round(t.value),
          min: round(t.min),
          max: round(t.max),
          unit: t.scaling.unit,
          passed: t.passed,
          saturated: t.saturated,
          highlight: testHighlight(Number.parseInt(t.mid, 16)),
        })),
      ),
    );
    for (const e of scan.monitors.perEcu)
      for (const f of e.failedMids)
        testIssues.push(`${e.ecu} MID ${f.mid.toString(16).toUpperCase().padStart(2, '0')}: ${f.status}`);
  }
  const vin = scan.identity?.vin;
  return {
    answered: true,
    ecus: ecus.map((e) => ({ id: e.id, role: e.role, name: e.name ?? null })),
    vin: vin
      ? ok(vin)
      : scan.identity
        ? notSupported('mode 09 VIN not answered')
        : notRead('mode 09 not read'),
    calid: infoList(scan, 0x04, 'calibration ID'),
    cvn: infoList(scan, 0x06, 'CVN'),
    ecuName: infoList(scan, 0x0a, 'ECU name'),
    mil: mil ? ok(!!mil.value) : notRead('PID 01 not answered'),
    dtcCount:
      count?.value !== null && count?.value !== undefined ? ok(count.value) : notRead('PID 01 not answered'),
    monitors: monitorsOf(scan, engine),
    counters: {
      distanceWithMilKm: counter(scan, engine, 'distance_mil_on', '21', adv(0x21)),
      warmupsSinceClear: counter(scan, engine, 'warmups_since_clear', '30', adv(0x30)),
      distanceSinceClearKm: counter(scan, engine, 'distance_since_clear', '31', adv(0x31)),
      minutesWithMil: counter(scan, engine, 'time_mil_on', '4D', adv(0x4d)),
      minutesSinceClear: counter(scan, engine, 'time_since_clear', '4E', adv(0x4e)),
      odometerKm: counter(scan, engine, 'odometer', 'A6', adv(0xa6)),
    },
    dtcs: {
      stored: dtcList(scan.dtcs.stored),
      pending: dtcList(scan.dtcs.pending),
      permanent: dtcList(scan.dtcs.permanent),
    },
    freezeFrames,
    tests,
    testIssues,
    // The last reading of each field per ECU (the scan reads some PIDs twice).
    readings: [
      ...new Map(
        scan.readings
          .filter((r) => r.service === 1 && r.state === 'ok' && !r.key.startsWith('monitor_') && !r.setBits)
          .map((r) => [`${r.ecu}:${r.key}`, r] as const),
      ).values(),
    ]
      .sort((a, b) => (a.ecu === engine ? 0 : 1) - (b.ecu === engine ? 0 : 1) || a.pid.localeCompare(b.pid))
      .map((r) => ({ ecu: r.ecu, pid: r.pid, name: r.name, value: shown(r), unit: r.unit })),
  };
}
