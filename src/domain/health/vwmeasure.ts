/**
 * VW measuring values over UDS ReadDataByIdentifier (22) for `live vwread`, `live vwlog` and `live vwread --sweep`:
 * the candidate identifier table, how each answer decodes, the CSV columns, and the read-only guard.
 *
 * What generic OBD-II hides on the Kushaq 1.0 TSI (engine 01 at 7E0/7E8, gearbox 02 at 7E1/7E9): per-cylinder knock
 * retard, specified vs actual charge pressure and rail pressure, per-cylinder misfire counters, converter slip. VW
 * engine ECUs serve these as manufacturer DIDs whose numbers are not published, so the table below is a list of
 * CANDIDATES gathered from community sources (each with its source and a confidence): `vwread` reads every one and
 * shows the raw answer next to the decoded value, so a wrong guess shows up as an implausible value or NRC 31
 * (requestOutOfRange: the ECU does not have that identifier). `--sweep` reads a whole range to find the ones the list
 * misses. The ISO 14229 OBD mirror identifiers (F4xx = mode 01 PID xx) are included as a known-good baseline.
 *
 * Strictly read-only: {@link assertVwRequest} allows 22 of one identifier, 3E tester present and 10 01 / 10 03
 * sessions, nothing else, and the CLI also locks the adapter's send policy (health lock and scan read-only lock).
 */

import { HealthReadOnlyViolation } from './readonly.ts';

export type VwUnit = '01' | '02';
export type Confidence = 'high' | 'medium' | 'low';
export type NumType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32';

/** A number at `offset` (bytes into the answer after the DID), `value = raw * scale + add`. */
export interface NumField {
  key: string;
  type: NumType;
  scale: number;
  add?: number;
  unit: string;
  /** Byte offset into the data (after the echoed DID); default: right after the previous field. */
  offset?: number;
}

export interface VwMeasure {
  unit: VwUnit;
  did: number;
  /** What the value is meant to be. */
  label: string;
  /** Decoded fields; empty = show raw hex only. */
  fields: readonly NumField[];
  confidence: Confidence;
  source: string;
  note?: string;
  /** Part of the default `vwlog` set. */
  log?: boolean;
}

export const VW_MODULES: Readonly<Record<VwUnit, { request: string; response: string; label: string }>> = {
  '01': { request: '7E0', response: '7E8', label: 'engine' },
  '02': { request: '7E1', response: '7E9', label: 'gearbox' },
};

const SIZE: Readonly<Record<NumType, number>> = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4 };

const f = (key: string, type: NumType, scale: number, unit: string, add = 0): NumField => ({
  key,
  type,
  scale,
  unit,
  ...(add ? { add } : {}),
});

const ISO =
  'ISO 14229-1 annex C / ISO 15031-5: DID F4xx mirrors OBD-II mode 01 PID xx (same bytes and scaling)';

/**
 * The candidate table. Order: OBD mirror baseline, then VW measuring values by subject. Keep sources and confidence
 * honest: "high" only for identifiers documented for this ECU family, "medium" for a documented sibling VW ECU,
 * "low" for a pattern guess the sweep should confirm.
 */
const OBDB_VIRTUS =
  'OBDb Volkswagen-Virtus signalset v3 (github.com/OBDb/Volkswagen-Virtus, signalsets/v3/default.json; Virtus 1.0 TSI = same MED17.1.27 04C907309 family)';
const OBDB_UNVERIFIED = `${OBDB_VIRTUS}, marked dbg (unverified there)`;
/** Identifiers the Kushaq's engine answered in the owner's raw 22 sweep of 1000-20FF (2026-11-09). */
const SWEPT = 'answers on this car (22 sweep 1000-20FF, 2026-11-09)';

type Extra = Partial<Pick<VwMeasure, 'note' | 'log'>>;
const m = (
  unit: VwUnit,
  did: number,
  label: string,
  fields: NumField[],
  confidence: Confidence,
  source: string,
  extra: Extra = {},
): VwMeasure => ({
  unit,
  did,
  label,
  fields,
  confidence,
  source,
  ...extra,
});

/**
 * The candidate table. "high" only for identifiers whose meaning is standardised (OBD mirrors) or that this car
 * answered with a value that checks out (odometer); "medium" for OBDb Virtus entries not marked unverified, or
 * unverified ones whose value on this car was plausible; "low" for the rest. Every engine entry outside F4xx/F6xx
 * answered on this car; the formulas are OBDb's and still need checking against known values while driving.
 */
export const VW_CANDIDATES: readonly VwMeasure[] = [
  // ---- engine: OBD mirror DIDs (ISO 14229 F4xx = mode 01 PID xx; F6xx = mode 06 MID xx) ---------------------------
  m('01', 0xf40c, 'engine speed (mirror of PID 0C)', [f('rpm', 'u16', 0.25, 'rpm')], 'high', ISO, {
    log: true,
  }),
  m('01', 0xf40d, 'vehicle speed (mirror of PID 0D)', [f('speed', 'u8', 1, 'km/h')], 'high', ISO),
  m(
    '01',
    0xf40e,
    'ignition timing advance, cyl 1 (mirror of PID 0E)',
    [f('timing', 'u8', 0.5, '°', -64)],
    'high',
    ISO,
    { log: true },
  ),
  m(
    '01',
    0xf40b,
    'intake manifold absolute pressure (mirror of PID 0B)',
    [f('map', 'u8', 1, 'kPa')],
    'high',
    ISO,
  ),
  m('01', 0xf404, 'calculated load (mirror of PID 04)', [f('load', 'u8', 100 / 255, '%')], 'high', ISO),
  m(
    '01',
    0xf423,
    'fuel rail pressure, gauge (mirror of PID 23)',
    [f('rail', 'u16', 10, 'kPa')],
    'high',
    ISO,
    {
      note: 'answers only if the ECU serves PID 23',
    },
  ),
  m(
    '01',
    0xf46d,
    'fuel pressure control: rail pressure COMMANDED vs ACTUAL (mirror of PID 6D)',
    [
      f('support', 'u8', 1, ''),
      f('rail_cmd', 'u16', 10, 'kPa'),
      f('rail_act', 'u16', 10, 'kPa'),
      f('fuel_temp', 'u8', 1, '°C', -40),
      f('rail_cmd_b', 'u16', 10, 'kPa'),
      f('rail_act_b', 'u16', 10, 'kPa'),
      f('fuel_temp_b', 'u8', 1, '°C', -40),
    ],
    'high',
    ISO,
    {
      log: true,
      note: 'the standard way to get specified vs actual rail pressure; answers only if the ECU serves PID 6D',
    },
  ),
  m(
    '01',
    0xf470,
    'boost pressure control: COMMANDED vs ACTUAL boost (mirror of PID 70)',
    [
      f('support', 'u8', 1, ''),
      f('boost_cmd_a', 'u16', 0.03125, 'kPa'),
      f('boost_act_a', 'u16', 0.03125, 'kPa'),
      f('boost_cmd_b', 'u16', 0.03125, 'kPa'),
      f('boost_act_b', 'u16', 0.03125, 'kPa'),
      f('status', 'u8', 1, ''),
    ],
    'high',
    ISO,
    { log: true, note: 'byte 0 bits say which values are valid; answers only if the ECU serves PID 70' },
  ),
  m(
    '01',
    0xf45c,
    'engine oil temperature (mirror of PID 5C)',
    [f('oil_temp', 'u8', 1, '°C', -40)],
    'high',
    ISO,
  ),
  m('01', 0xf6a1, 'misfire monitor, general (mirror of mode 06 MID A1)', [], 'medium', ISO, {
    note: 'mode 06 test records, raw',
  }),
  m(
    '01',
    0xf6a2,
    'misfire monitor cyl 1 (mirror of mode 06 MID A2: TID 0B EWMA, 0C this cycle)',
    [],
    'medium',
    ISO,
    { note: 'mode 06 test records, raw' },
  ),
  m('01', 0xf6a3, 'misfire monitor cyl 2 (mirror of mode 06 MID A3)', [], 'medium', ISO, {
    note: 'mode 06 test records, raw',
  }),
  m('01', 0xf6a4, 'misfire monitor cyl 3 (mirror of mode 06 MID A4)', [], 'medium', ISO, {
    note: 'mode 06 test records, raw',
  }),

  // ---- engine: VW measuring values (all answered on this car) ------------------------------------------------------
  m(
    '01',
    0x10e0,
    'odometer',
    [f('odometer', 'u32', 1, 'km')],
    'high',
    `${OBDB_VIRTUS}; ${SWEPT}: 27417 km, matches the car`,
  ),
  m(
    '01',
    0x13f4,
    'IGA_CYL_KNK[2]: ignition angle after knock control, cylinder index 2 (Bosch label)',
    [f('iga_knk', 'u8', 0.375, '°CA', -48), f('byte1', 'u8', 1, '')],
    'medium',
    `${OBDB_UNVERIFIED}; ${SWEPT} (2 bytes: 85 E6)`,
    {
      log: true,
      note: 'OBDb decodes byte 0 only; 13F2/13F3/13F5 (other indices) are not served. Whether it is the retard or the corrected angle: compare with F40E',
    },
  ),
  m(
    '01',
    0x120e,
    'knock sensor signal, cyl "1" (OBDb, 4-cyl naming)',
    [f('knock_v', 'u16', 0.0048489933, 'V')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
    { note: '120E/120F/1210 = three cylinders on this R3' },
  ),
  m(
    '01',
    0x120f,
    'knock sensor signal, cyl "3" (OBDb)',
    [f('knock_v', 'u16', 0.0048489933, 'V')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x1210,
    'knock sensor signal, cyl "4" (OBDb)',
    [f('knock_v', 'u16', 0.0048489933, 'V')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x11f0,
    'charge (boost) pressure, ACTUAL',
    [f('boost_act', 'u16', 0.078125, 'hPa')],
    'medium',
    `${OBDB_UNVERIFIED} (no scale there; ×0.078125 hPa as 11DD and OBDb Jetta/T-Roc); ${SWEPT}: 992 hPa = ambient at low load`,
    { log: true },
  ),
  m(
    '01',
    0x11f1,
    'charge pressure SPECIFIED? (OBDb Virtus says gearbox input speed ÷2 rpm)',
    [f('as_hpa', 'u16', 0.078125, 'hPa')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}: 7558 = 590 hPa or 3779 rpm (implausible at ~1100 rpm)`,
    {
      log: true,
      note: 'check while driving: tracks 11F0 under boost = specified charge pressure',
    },
  ),
  m(
    '01',
    0x11dd,
    'intake manifold pressure, SPECIFIED',
    [f('map_spec', 'u16', 0.078125, 'hPa')],
    'medium',
    `${OBDB_UNVERIFIED}; ${SWEPT}: 604 hPa`,
    { log: true },
  ),
  m(
    '01',
    0x11dc,
    'intake manifold pressure, ACTUAL (OBDb "raw value")',
    [f('map_act', 'u16', 0.078125, 'hPa')],
    'medium',
    `${OBDB_UNVERIFIED}; ${SWEPT}: 604 hPa, = 11DD`,
    { log: true },
  ),
  m(
    '01',
    0x1219,
    'boost regulation duty (wastegate), specified',
    [f('wg_duty', 'u16', 0.0234384354, '%')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x11ff,
    'boost pressure control adaptation 0',
    [f('adapt', 's8', 2.81, '')],
    'low',
    `${OBDB_UNVERIFIED} (EA888 label); ${SWEPT}`,
  ),
  m(
    '01',
    0x1200,
    'boost pressure control adaptation 1',
    [f('adapt', 's8', 2.81, '')],
    'low',
    `${OBDB_UNVERIFIED} (EA888 label); ${SWEPT}`,
  ),
  m(
    '01',
    0x1201,
    'boost pressure control adaptation 2',
    [f('adapt', 's8', 2.81, '')],
    'low',
    `${OBDB_UNVERIFIED} (EA888 label); ${SWEPT}`,
  ),
  m(
    '01',
    0x11d5,
    'high fuel (rail) pressure regulation error',
    [f('rail_err', 's16', 1 / 2000, 'MPa?')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
    {
      log: true,
      note: 'no documented rail actual/specified DID in 1000-13FF for this ECU (OBDb 11D7 is not served): use F46D / F423',
    },
  ),
  m(
    '01',
    0x11d2,
    'high pressure control adaptation',
    [f('rail_adapt', 's16', 1 / 2000, '')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x11a4,
    'fuel pump (low pressure) commanded duty',
    [f('pump_duty', 'u16', 0.0015258743, '%')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m('01', 0x1146, 'misfires, total', [f('misfires', 'u16', 1, '')], 'low', `${OBDB_UNVERIFIED}; ${SWEPT}`),
  m(
    '01',
    0x1147,
    'misfires per 1000 rev, cyl "1"',
    [f('misfires', 'u16', 1, '')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x1149,
    'misfires per 1000 rev, cyl "4" (OBDb naming)',
    [f('misfires', 'u16', 1, '')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x114f,
    'misfire counter, cyl "1"',
    [f('count', 'u16', 1, '')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}: 29725`,
    {
      note: '114F/1150/1151 = three cylinders on this R3? values are large (lifetime counts or another quantity)',
    },
  ),
  m(
    '01',
    0x1150,
    'misfire counter, cyl "3"',
    [f('count', 'u16', 1, '')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}: 28100`,
  ),
  m(
    '01',
    0x1151,
    'misfire counter, cyl "4"',
    [f('count', 'u16', 1, '')],
    'medium',
    `${OBDB_VIRTUS}; ${SWEPT}: 18676`,
  ),
  m(
    '01',
    0x1216,
    'relative load',
    [f('load', 'u16', 0.0234403081, '%')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x121c,
    'air filling (cylinder charge)',
    [f('fill', 'u16', 0.023438, '%')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x1010,
    'engine torque, actual',
    [f('torque', 's16', 0.1, 'Nm')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x11e0,
    'crankshaft torque, specified',
    [f('torque_spec', 's16', 0.1, 'Nm')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x113f,
    'fuel rate',
    [f('fuel_rate', 'u16', 0.01, 'l/h')],
    'medium',
    `${OBDB_VIRTUS}; ${SWEPT}: 1.43 l/h`,
  ),
  m(
    '01',
    0x1135,
    'coolant temperature, radiator outlet',
    [f('coolant_out', 'u16', 0.1, '°C', -273.1)],
    'medium',
    `${OBDB_UNVERIFIED}; ${SWEPT}: 90.0 °C`,
  ),
  m(
    '01',
    0x11bd,
    'engine oil temperature',
    [f('oil_temp', 'u16', 0.1, '°C', -273.1)],
    'medium',
    `${OBDB_VIRTUS}; ${SWEPT}: 102.5 °C`,
  ),
  m('01', 0x11ba, 'oil level', [f('oil_level', 'u16', 1 / 2500, 'cm')], 'low', `${OBDB_VIRTUS}; ${SWEPT}: 0`),
  m(
    '01',
    0x128a,
    'fuel temperature',
    [f('fuel_temp', 'u8', 0.75, '°C', -48)],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x1282,
    'exhaust gas temperature before catalyst (modelled)',
    [f('egt', 'u16', 0.02, '°C', -193.93)],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x136e,
    'intake cam adjustment, actual',
    [f('cam_in_act', 's16', 0.0078125, '°CA')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x1373,
    'intake cam adjustment, specified',
    [f('cam_in_spec', 's16', 0.008, '°CA')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x136c,
    'exhaust cam adjustment, actual',
    [f('cam_ex_act', 's16', 0.008, '°CA')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),
  m(
    '01',
    0x1371,
    'exhaust cam adjustment, specified',
    [f('cam_ex_spec', 's16', 0.008, '°CA')],
    'low',
    `${OBDB_UNVERIFIED}; ${SWEPT}`,
  ),

  // ---- gearbox 02 (AISIN AG6 at 7E1/7E9): nothing documented for the AG6; sweep 1000-13FF on 02 ---------------
  m(
    '02',
    0xf4a4,
    'transmission actual gear (mirror of PID A4)',
    [f('support', 'u8', 1, ''), f('gear_raw', 'u8', 1, ''), f('ratio', 'u16', 0.001, '')],
    'medium',
    ISO,
    {
      log: true,
      note: 'gear = gear_raw >> 4; answers only if the TCU serves PID A4',
    },
  ),
  m(
    '02',
    0xf40c,
    'engine speed seen by the TCU (mirror of PID 0C)',
    [f('rpm', 'u16', 0.25, 'rpm')],
    'medium',
    ISO,
  ),
  m(
    '02',
    0x0301,
    'control module temperature',
    [f('tcu_temp', 'u8', 1, '°C', -40)],
    'low',
    `${OBDB_UNVERIFIED} (7E1; mostly DSG data)`,
  ),
  m('02', 0x0327, 'gear ratio', [f('ratio', 's8', 0.01, '')], 'low', `${OBDB_UNVERIFIED} (7E1)`),
  m(
    '02',
    0x1010,
    'converter loss torque',
    [f('conv_loss', 's16', 0.05, 'Nm')],
    'low',
    `${OBDB_UNVERIFIED} (7E1, torque-converter item)`,
  ),
  m(
    '02',
    0x1029,
    'lock-up clutch valve N371 current',
    [f('n371', 'u16', 0.1, 'mA')],
    'low',
    `${OBDB_UNVERIFIED} (7E1, torque-converter item)`,
    { log: true },
  ),
];

// ---- parsing ------------------------------------------------------------------------------------

export const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** `F40C,02:1234, 7E0:39C0`-style list → (unit, did) pairs; a bare DID belongs to `defaultUnit`. */
export function parseDidSpec(text: string, defaultUnit: VwUnit): { unit: VwUnit; did: number }[] {
  const out: { unit: VwUnit; did: number }[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(?:(01|02):)?([0-9a-f]{4})$/i.exec(raw);
    if (!m)
      throw new Error(
        `"${raw}" is not a DID: use 4 hex digits, optionally prefixed by the unit (01: or 02:), e.g. 39C0,02:2101`,
      );
    const unit = (m[1] ?? defaultUnit) as VwUnit;
    const did = Number.parseInt(m[2]!, 16);
    if (!out.some((x) => x.unit === unit && x.did === did)) out.push({ unit, did });
  }
  return out;
}

/** The largest range `--sweep` reads in one run (each read costs ~0.2–1.5 s on the clone). */
export const SWEEP_MAX = 0x1000;

/** `2000-20FF` → [0x2000 … 0x20FF]; refuses empty, reversed or oversized ranges. */
export function parseSweepRange(text: string): number[] {
  const m = /^([0-9a-f]{4})(?:-([0-9a-f]{4}))?$/i.exec(text.trim());
  if (!m) throw new Error(`--sweep takes a DID range like 2000-20FF, got "${text}"`);
  const a = Number.parseInt(m[1]!, 16);
  const b = m[2] ? Number.parseInt(m[2], 16) : a;
  if (b < a) throw new Error(`--sweep range ${text} runs backwards`);
  if (b - a + 1 > SWEEP_MAX)
    throw new Error(`--sweep range ${text} has ${b - a + 1} identifiers; at most ${SWEEP_MAX} per run`);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** The candidates to read: the table (optionally only one unit), then extra DIDs not in it (raw only). */
export function selectMeasures(
  units: readonly VwUnit[],
  extra: readonly { unit: VwUnit; did: number }[],
  onlyExtra = false,
): VwMeasure[] {
  const table = onlyExtra ? [] : VW_CANDIDATES.filter((m) => units.includes(m.unit));
  const out = [...table];
  for (const e of extra) {
    const known = VW_CANDIDATES.find((m) => m.unit === e.unit && m.did === e.did);
    if (out.some((m) => m.unit === e.unit && m.did === e.did)) continue;
    out.push(
      known ?? {
        unit: e.unit,
        did: e.did,
        label: '(not in the table: raw only)',
        fields: [],
        confidence: 'low',
        source: '--dids',
      },
    );
  }
  return out;
}

/** The default `vwlog` set: the table's `log` entries of the given units. */
export function defaultLogMeasures(units: readonly VwUnit[]): VwMeasure[] {
  return VW_CANDIDATES.filter((m) => m.log && units.includes(m.unit));
}

// ---- decoding -----------------------------------------------------------------------------------

function readNum(bytes: readonly number[], at: number, type: NumType): number | null {
  const n = SIZE[type];
  if (at < 0 || at + n > bytes.length) return null;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + bytes[at + i]!;
  if (type[0] === 's' && v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n);
  return v;
}

export interface Decoded {
  /** field key → value (null: the answer was too short for it). */
  values: Record<string, number | null>;
  /** Human text, e.g. "rpm 812.5 rpm, …", or the reason it is raw only. */
  text: string;
  /** The answer's length differs from what the fields need (a sign the guess is wrong). */
  lengthMismatch: boolean;
}

export function fieldOffsets(fields: readonly NumField[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const fl of fields) {
    const o = fl.offset ?? at;
    out.push(o);
    at = o + SIZE[fl.type];
  }
  return out;
}

export function expectedLength(fields: readonly NumField[]): number {
  const offs = fieldOffsets(fields);
  return fields.reduce((m, fl, i) => Math.max(m, offs[i]! + SIZE[fl.type]), 0);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Decodes the data bytes of a positive answer (after 62 and the DID). */
export function decodeMeasure(m: Pick<VwMeasure, 'fields'>, data: readonly number[]): Decoded {
  if (!m.fields.length) return { values: {}, text: 'raw only (no formula)', lengthMismatch: false };
  const offs = fieldOffsets(m.fields);
  const values: Record<string, number | null> = {};
  const parts: string[] = [];
  m.fields.forEach((fl, i) => {
    const raw = readNum(data, offs[i]!, fl.type);
    const v = raw === null ? null : round(raw * fl.scale + (fl.add ?? 0));
    values[fl.key] = v;
    parts.push(`${fl.key} ${v === null ? 'n/a' : v}${fl.unit && v !== null ? ` ${fl.unit}` : ''}`);
  });
  const need = expectedLength(m.fields);
  const lengthMismatch = data.length !== need;
  return {
    values,
    text:
      parts.join(', ') + (lengthMismatch ? ` (answer ${data.length} byte(s), formula expects ${need})` : ''),
    lengthMismatch,
  };
}

// ---- answers ------------------------------------------------------------------------------------

/** NRCs worth naming in the output. */
export const NRC_TEXT: Readonly<Record<number, string>> = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'sub-function not supported',
  0x13: 'wrong length',
  0x14: 'response too long',
  0x22: 'conditions not correct',
  0x31: 'not supported (request out of range: the unit has no such DID)',
  0x33: 'security access denied (needs a login: not read)',
  0x7e: 'not supported in this session',
  0x7f: 'service not supported in this session (try --extended)',
};

export const nrcText = (code: number) =>
  `NRC ${code.toString(16).toUpperCase().padStart(2, '0')} ${NRC_TEXT[code] ?? ''}`.trim();

/** An answer that means "this identifier exists" (positive, or refused for a reason other than not having it). */
export function didExists(answer: { kind: string; code?: number }): boolean {
  if (answer.kind === 'ok' || answer.kind === 'truncated') return true;
  return (
    answer.kind === 'nrc' &&
    answer.code !== 0x31 &&
    answer.code !== 0x11 &&
    answer.code !== 0x12 &&
    answer.code !== 0x13
  );
}

// ---- CSV ----------------------------------------------------------------------------------------

/** One CSV column per decoded field (header `01:F40C_rpm (rpm)`); a raw-only DID gets one hex column. */
export function vwColumns(measures: readonly VwMeasure[]): { pid: string; key: string; unit: string }[] {
  const out: { pid: string; key: string; unit: string }[] = [];
  for (const m of measures) {
    const pid = m.unit;
    if (!m.fields.length) out.push({ pid, key: `raw_${hex4(m.did)}`, unit: 'hex' });
    for (const fl of m.fields) out.push({ pid, key: `${hex4(m.did)}_${fl.key}`, unit: fl.unit });
  }
  return out;
}

/** The CSV values of one decoded answer (keys as {@link vwColumns}). Raw columns hold the hex as a number-less note. */
export function vwValues(m: VwMeasure, decoded: Decoded): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(decoded.values)) out[`${hex4(m.did)}_${k}`] = v;
  return out;
}

// ---- read-only guard -----------------------------------------------------------------------------

/**
 * Throws unless the request is 22 of exactly one identifier, 3E 00 / 3E 80 or 10 01 / 10 03. Narrower than the health
 * guard: no OBD-II and no 19 either. 2E, 2F, 31, 14, 27, 11, 28, 85 and 10 02 are all refused here, and again by the
 * adapter's send policy.
 */
export function assertVwRequest(pdu: readonly number[]): void {
  const ok =
    pdu.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff) &&
    ((pdu[0] === 0x22 && pdu.length === 3) ||
      (pdu[0] === 0x3e && pdu.length === 2 && (pdu[1] === 0x00 || pdu[1] === 0x80)) ||
      (pdu[0] === 0x10 && pdu.length === 2 && (pdu[1] === 0x01 || pdu[1] === 0x03)));
  if (!ok) {
    const shown = pdu.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '(empty)';
    throw new HealthReadOnlyViolation(
      `the request ${shown} (vwread / vwlog send only 22 reads, 3E and 10 01 / 10 03)`,
    );
  }
}
