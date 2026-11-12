import { bracketText, type LogSummary, THRESHOLDS, type ThrottleEvent, timingBandsText } from './livelog.ts';
import type { HealthSnapshot } from './snapshot.ts';
import {
  faultClass,
  faultDtcs,
  UDS_DTC_MEANING,
  type UdsDtc,
  type UnitHealth,
  udsDtcLabel,
  udsDtcRemark,
} from './uds.ts';

/**
 * The service advisor's page (`live report <health.json> [log.csv …]`): one printable page in three sections —
 * Confirmed faults, Suspicious readings, Looks normal — each finding with its evidence (time, conditions, numbers), a
 * severity, how it relates to the owner's two complaints, and one job-card sentence (symptom + condition + effect on
 * function) the advisor can copy onto the job card.
 *
 * Confirmed = the car itself stored it (a stored / permanent OBD code, a UDS DTC with the confirmed 08 or test-failed
 * 01 bit, the MIL on). Engine OBD codes (modes 03 / 07 / 0A) are SAE codes and get the SAE meaning; a control unit's
 * UDS DTC is a VW-internal number, shown as "VW 17142 (0x0042F6)" with no SAE code and no meaning (the SAE reading of
 * those bytes is wrong for VW), and its severity comes from the unit alone. Suspicious = the car did not store a code but a reading is past one of {@link THRESHOLDS} or a
 * code is only pending (04) or failed since the last clear (20). A UDS entry with none of those bits (only 10 / 40
 * "test not completed") is not a fault and never a finding: old snapshots listed them (`19 02 FF`), they are filtered
 * here. The relations to the complaints are the usual technical links, stated as "may relate", never as a
 * diagnosis.
 */

export const COMPLAINTS = {
  clatter: 'metallic "diesel-like" clatter while driving',
  power: 'long delay before power on full throttle',
} as const;
export type Complaint = keyof typeof COMPLAINTS;

export type Severity = 'safety' | 'drivability' | 'emissions' | 'minor';

export interface Finding {
  section: 'confirmed' | 'suspicious' | 'normal';
  title: string;
  severity: Severity;
  relates: Complaint[];
  evidence: string[];
  jobCard: string;
}

export interface CarContext {
  car: string;
  odometerKm: number | null;
}

/** Code ranges (generic SAE groups) and what they say about severity and the two complaints. */
const CODE_RULES: readonly {
  test: (code: string) => boolean;
  severity: Severity;
  relates: Complaint[];
  part: string;
}[] = [
  {
    test: (c) => /^P03(2[4-9]|3[0-4])/.test(c),
    severity: 'drivability',
    relates: ['clatter', 'power'],
    part: 'knock sensing',
  },
  {
    test: (c) => /^P030[0-9]/.test(c) || /^P031[0-6]/.test(c),
    severity: 'drivability',
    relates: ['clatter', 'power'],
    part: 'misfire',
  },
  {
    test: (c) => /^P00(1[0-9]|2[0-5])/.test(c),
    severity: 'drivability',
    relates: ['clatter', 'power'],
    part: 'camshaft timing',
  },
  {
    test: (c) => /^P00(8[7-9]|9[0-3])/.test(c) || /^P019[0-3]/.test(c),
    severity: 'drivability',
    relates: ['power', 'clatter'],
    part: 'fuel rail pressure',
  },
  {
    test: (c) => /^P0(234|299)/.test(c) || /^P024[3-9]/.test(c) || /^P004[5-9]/.test(c) || /^P2563/.test(c),
    severity: 'drivability',
    relates: ['power'],
    part: 'turbo boost',
  },
  {
    test: (c) => /^P010[0-6]/.test(c) || /^P0(068|069)/.test(c) || /^P2279/.test(c),
    severity: 'drivability',
    relates: ['power'],
    part: 'air mass / intake pressure',
  },
  {
    test: (c) => /^P012[0-3]/.test(c) || /^P2(10[0-9]|11[0-9]|13[5-9])/.test(c),
    severity: 'drivability',
    relates: ['power'],
    part: 'throttle / pedal',
  },
  {
    test: (c) => /^P07/.test(c) || /^P08/.test(c),
    severity: 'drivability',
    relates: ['power'],
    part: 'automatic gearbox',
  },
  { test: (c) => /^P04[23]/.test(c), severity: 'emissions', relates: [], part: 'catalyst' },
  { test: (c) => /^P01[3-6]/.test(c), severity: 'emissions', relates: [], part: 'oxygen sensor' },
  {
    test: (c) => /^P017[0-5]/.test(c) || /^P218[7-9]/.test(c),
    severity: 'emissions',
    relates: ['power'],
    part: 'fuel trim (mixture)',
  },
  { test: (c) => /^P04[4-5]/.test(c), severity: 'emissions', relates: [], part: 'evaporative system' },
  { test: (c) => /^C/.test(c), severity: 'safety', relates: [], part: 'chassis / brakes' },
];

/** Units whose faults are safety-relevant whatever the code: ABS/ESC, airbags, steering, parking brake. */
const SAFETY_UNITS = new Set(['03', '15', '44', '53']);
const POWERTRAIN_UNITS = new Set(['01', '02']);

function classify(code: string, unit?: string): { severity: Severity; relates: Complaint[]; part: string } {
  const rule = CODE_RULES.find((r) => r.test(code));
  if (unit && SAFETY_UNITS.has(unit))
    return { severity: 'safety', relates: rule?.relates ?? [], part: rule?.part ?? 'safety system' };
  if (rule) return rule;
  if (unit && POWERTRAIN_UNITS.has(unit))
    return { severity: 'drivability', relates: [], part: unit === '01' ? 'engine' : 'gearbox' };
  return { severity: 'minor', relates: [], part: 'electrical' };
}

const relatesText = (r: Complaint[]) =>
  r.length ? r.map((c) => COMPLAINTS[c]).join('; ') : 'not related to the two complaints';
const when = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const fmt = (v: number | null, unit: string, digits = 0) =>
  v === null ? 'n/a' : `${v.toFixed(digits)} ${unit}`.trim();

function udsFinding(s: HealthSnapshot, u: UnitHealth, d: UdsDtc, section: Finding['section']): Finding {
  // By unit only: the DTC number says nothing in SAE terms.
  const c = classify('', u.unit);
  const label = udsDtcLabel(d);
  const remark = udsDtcRemark(d);
  const mileage = d.snapshot?.records?.flatMap((r) => r.values).find((v) => v.did === '2002');
  const freq = d.extended?.records?.find((r) => r.record === 0x02);
  const evidence = [
    `${when(s.takenAt)}: unit ${u.unit} ${u.label} reports ${label}, ${faultClass(d.status)}, status ${d.statusHex} (${d.statusBits.join(', ') || 'no bit set'})`,
    `${UDS_DTC_MEANING}${remark ? `; ${remark}` : ''}`,
  ];
  const snap =
    d.snapshot?.records?.flatMap((r) => r.values).filter((v) => v.value !== undefined && v.did !== '2002') ??
    [];
  if (snap.length)
    evidence.push(
      `conditions when stored: ${snap.map((v) => `${v.name ?? v.did} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join(', ')}`,
    );
  if (mileage?.value !== undefined)
    evidence.push(`stored at ${mileage.value} km (VW snapshot mileage, unverified)`);
  if (freq?.value !== undefined)
    evidence.push(`occurred ${freq.value} time(s) (VW frequency counter, unverified)`);
  return {
    section,
    title: `${label} in ${u.label} (${c.part})`,
    severity: c.severity,
    relates: c.relates,
    evidence,
    jobCard: `${u.label}: fault ${label} ${faultClass(d.status) === 'confirmed' ? 'stored' : faultClass(d.status)} on ${s.takenAt.slice(0, 10)} at ${s.odometer.km ?? '?'} km (meaning to be read with the VW tester); customer requests diagnosis and repair of the cause, not only clearing.`,
  };
}

export function healthFindings(s: HealthSnapshot): Finding[] {
  const out: Finding[] = [];
  const o = s.obd;
  if (o.answered && o.mil.status === 'ok' && o.mil.value) {
    out.push({
      section: 'confirmed',
      title: 'Check-engine light (MIL) on',
      severity: 'emissions',
      relates: [],
      evidence: [
        `${when(s.takenAt)}: PID 01 reports the MIL on${o.counters.distanceWithMilKm.status === 'ok' ? `, ${o.counters.distanceWithMilKm.value} km driven with it on` : ''}`,
      ],
      jobCard: `Check-engine light is on (${s.takenAt.slice(0, 10)}, ${s.odometer.km ?? '?'} km); customer requests diagnosis and repair.`,
    });
  }
  for (const kind of ['stored', 'permanent', 'pending'] as const) {
    for (const code of o.dtcs[kind].codes) {
      const c = classify(code.code, '01');
      const ff = o.freezeFrames.find((f) => f.dtc === code.code && f.ecu === code.ecu);
      out.push({
        section: kind === 'pending' ? 'suspicious' : 'confirmed',
        title: `${code.code} ${kind} in the engine ECU (${c.part})`,
        severity: c.severity,
        relates: c.relates,
        evidence: [
          `${when(s.takenAt)}: mode ${kind === 'stored' ? '03' : kind === 'pending' ? '07' : '0A'} ${code.ecu} reports ${code.code}: ${code.meaning}`,
          ...(ff
            ? [
                `freeze frame: ${ff.values.map((v) => `${v.name} ${v.value ?? 'n/a'}${v.unit ? ` ${v.unit}` : ''}`).join(', ')}`,
              ]
            : []),
          ...(kind === 'permanent'
            ? [
                'permanent code: cannot be cleared with a tester; only the ECU removes it after the fault stops',
              ]
            : []),
        ],
        jobCard: `Engine fault ${code.code} (${code.meaning.startsWith('meaning:') ? code.meaning.replace(/^meaning: unknown \((.*)\)$/, '$1') : code.meaning}) ${kind} on ${s.takenAt.slice(0, 10)} at ${s.odometer.km ?? '?'} km; customer requests diagnosis and repair of the cause, not only clearing.`,
      });
    }
  }
  for (const u of s.units) {
    for (const d of faultDtcs(u.faults)) {
      // Confirmed (08) or failing now (01): the car stored or sees it. Pending (04) or failed since clear (20): not yet.
      const c = d.status & 0x09 ? 'confirmed' : 'suspicious';
      out.push(udsFinding(s, u, d, c));
    }
    if (u.reachable && (u.faults.status === 'no answer' || u.faults.status === 'not supported')) {
      const lamp = SAFETY_UNITS.has(u.unit) ? ` and check the ${u.label} warning lamp` : '';
      out.push({
        section: 'suspicious',
        title: `${u.label}: fault memory not read${lamp ? ' (check the warning lamp)' : ''}`,
        severity: 'minor',
        relates: [],
        evidence: [
          `${when(s.takenAt)}: unit ${u.unit} answered its identity but not the fault list: ${u.faults.notes.join('; ') || u.faults.status}; nothing is known about its faults`,
        ],
        jobCard: `${u.label}: please read the fault memory with the workshop tester${lamp} (the owner's adapter could not read it).`,
      });
    }
    if (u.faults.status === 'partial') {
      out.push({
        section: 'suspicious',
        title: `${u.label}: fault list only partly read`,
        severity: 'minor',
        relates: [],
        evidence: u.faults.notes.map((n) => `${when(s.takenAt)}: ${n}`),
        jobCard: `${u.label}: please read the complete fault memory with the workshop tester (the owner's adapter could only read part of it).`,
      });
    }
  }
  if (o.tests.status === 'ok') {
    for (const t of o.tests.value.filter((x) => !x.passed && !x.saturated)) {
      const misfire = t.highlight?.startsWith('misfire');
      out.push({
        section: 'suspicious',
        title: `Self-test outside limits: ${t.midName}, ${t.tidName}`,
        severity: misfire ? 'drivability' : 'emissions',
        relates: misfire ? ['clatter', 'power'] : [],
        evidence: [
          `${when(s.takenAt)}: mode 06 ${t.ecu} MID ${t.mid} TID ${t.tid}: ${t.value} ${t.unit ?? ''} outside ${t.min}..${t.max}`,
        ],
        jobCard: `Engine self-test ${t.midName} (${t.tidName}) failed on ${s.takenAt.slice(0, 10)}: ${t.value} outside ${t.min}..${t.max}; please check.`,
      });
    }
    const misfire = o.tests.value.filter(
      (t) => t.tid === '0B' && t.highlight?.startsWith('misfire cylinder'),
    );
    const high = misfire.filter((t) => t.value >= THRESHOLDS.misfireCount);
    if (high.length) {
      out.push({
        section: 'suspicious',
        title: 'Misfire counters raised',
        severity: 'drivability',
        relates: ['clatter', 'power'],
        evidence: [
          `${when(s.takenAt)}: mode 06 misfire count (average of recent drive cycles) ${misfire.map((t) => `${t.highlight?.replace('misfire ', '')} ${t.value}`).join(', ')}; at or above ${THRESHOLDS.misfireCount} on ${high.length} cylinder(s), no misfire code stored and no mode 06 limit exceeded (VW scaling of the counter unverified)`,
        ],
        jobCard: `Engine misfire counters raised (${misfire.map((t) => `${t.highlight?.replace('misfire ', '')} ${t.value}`).join(', ')}) on ${s.takenAt.slice(0, 10)} with a clatter and slow response; please check ignition, injectors and compression.`,
      });
    } else if (misfire.length) {
      out.push({
        section: 'normal',
        title: 'Misfire counters low',
        severity: 'minor',
        relates: [],
        evidence: [
          `mode 06: ${misfire.map((t) => `${t.highlight?.replace('misfire ', '')} ${t.value}`).join(', ')}`,
        ],
        jobCard: '',
      });
    }
  }
  if (
    o.answered &&
    o.mil.status === 'ok' &&
    !o.mil.value &&
    !o.dtcs.stored.codes.length &&
    o.dtcs.stored.status === 'ok'
  ) {
    out.push({
      section: 'normal',
      title: 'Engine: MIL off, no stored codes',
      severity: 'minor',
      relates: [],
      evidence: [`${when(s.takenAt)}: PID 01 and mode 03`],
      jobCard: '',
    });
  }
  if (o.monitors.status === 'ok') {
    const inc = o.monitors.value.filter((m) => m.status === 'incomplete');
    out.push(
      inc.length
        ? {
            section: 'suspicious',
            title: `Readiness monitors incomplete: ${inc.map((m) => m.name).join(', ')}`,
            severity: 'minor',
            relates: [],
            evidence: [
              `${when(s.takenAt)}: PID 01; incomplete monitors are normal shortly after a code clear or a battery disconnect`,
            ],
            jobCard: '',
          }
        : {
            section: 'normal',
            title: 'All supported readiness monitors complete',
            severity: 'minor',
            relates: [],
            evidence: [`${when(s.takenAt)}: PID 01`],
            jobCard: '',
          },
    );
  }
  if (o.tests.status === 'ok' && o.tests.value.every((t) => t.passed)) {
    out.push({
      section: 'normal',
      title: `All ${o.tests.value.length} engine self-tests within limits`,
      severity: 'minor',
      relates: [],
      evidence: ['mode 06'],
      jobCard: '',
    });
  }
  const clean = s.units.filter((u) => u.reachable && u.faults.status === 'ok' && !faultDtcs(u.faults).length);
  const notFaults = s.units
    .filter((u) => u.reachable)
    .map((u) => ({ u, n: u.faults.dtcs.length - faultDtcs(u.faults).length }))
    .filter((x) => x.n > 0);
  if (notFaults.length)
    out.push({
      section: 'normal',
      title: `Not faults: ${notFaults.reduce((n, x) => n + x.n, 0)} listed entries with no fault bit (only "test not completed" and similar)`,
      severity: 'minor',
      relates: [],
      evidence: [
        `${notFaults.map((x) => `${x.u.label} ${x.n}`).join(', ')}; status & 2D = 0 (not failed, pending, confirmed or failed since the last clear)`,
      ],
      jobCard: '',
    });
  if (clean.length)
    out.push({
      section: 'normal',
      title: `No fault codes in ${clean.length} unit(s)`,
      severity: 'minor',
      relates: [],
      evidence: [clean.map((u) => u.label).join(', ')],
      jobCard: '',
    });
  return out;
}

/**
 * Several findings with the same section and title (e.g. one per log) as one: their evidence together. The job card of
 * the first stays, with a pointer to the others.
 */
export function mergeFindings(fs: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  const count = new Map<Finding, number>();
  for (const f of fs) {
    const same =
      f.section !== 'confirmed' ? out.find((x) => x.section === f.section && x.title === f.title) : undefined;
    if (!same) {
      const copy = { ...f, evidence: [...f.evidence], relates: [...f.relates] };
      out.push(copy);
      count.set(copy, 1);
      continue;
    }
    for (const e of f.evidence) if (!same.evidence.includes(e)) same.evidence.push(e);
    for (const r of f.relates) if (!same.relates.includes(r)) same.relates.push(r);
    count.set(same, (count.get(same) ?? 1) + 1);
  }
  for (const f of out) {
    const n = count.get(f) ?? 1;
    if (n > 1 && f.jobCard)
      f.jobCard = `${f.jobCard} (Also seen in ${n - 1} other log(s): see the evidence.)`;
  }
  return out;
}

/**
 * Findings from one live-data log's summary. `startedAt` turns the log's offsets into wall-clock times. One finding per
 * kind, with every full-throttle event of that kind in its evidence (not one finding per event).
 */
export function logFindings(s: LogSummary, scenarioTitle: string, startedAt: string | undefined): Finding[] {
  const out: Finding[] = [];
  const t = (ms: number) => {
    if (!startedAt) return `+${(ms / 1000).toFixed(1)} s`;
    const d = new Date(Date.parse(startedAt) + ms);
    return Number.isNaN(d.getTime()) ? `+${(ms / 1000).toFixed(1)} s` : when(d.toISOString());
  };
  const label = `scenario ${s.scenario} (${scenarioTitle})`;
  const cond = (e: ThrottleEvent, i: number) =>
    `${label}, full throttle #${i + 1} at ${t(e.startMs)}, ${fmt(e.speedStartKmh, 'km/h')} → ${fmt(e.speedEndKmh, 'km/h')}, ${fmt(e.rpmStart, 'rpm')} → ${fmt(e.rpmPeak, 'rpm')}`;
  type Kind = { title: string; relates: Complaint[]; lines: string[]; jobs: string[] };
  const kinds = new Map<string, Kind>();
  const hit = (title: string, relates: Complaint[], line: string, job: string) => {
    const k = kinds.get(title) ?? { title, relates, lines: [], jobs: [] };
    k.lines.push(line);
    k.jobs.push(job);
    kinds.set(title, k);
  };
  const clean: string[] = [];
  const dips: string[] = [];
  for (const [i, e] of s.throttleEvents.entries()) {
    const c = cond(e, i);
    let any = false;
    const b = e.fullBoostMs;
    if (b !== null && b.lo > THRESHOLDS.slowBoostMs) {
      any = true;
      hit(
        'Slow boost build-up at full throttle',
        ['power'],
        `${c}: full boost (${Math.round(THRESHOLDS.fullBoostFraction * 100)} % of the peak, MAP up to ${fmt(e.mapPeakKpa, 'kPa')}) reached ${bracketText(b)} after pedal down (at least ${(b.lo / 1000).toFixed(1)} s: over ${THRESHOLDS.slowBoostMs / 1000} s)`,
        `${t(e.startMs)} from ${fmt(e.speedStartKmh, 'km/h')}: at least ${(b.lo / 1000).toFixed(1)} s to full boost`,
      );
    }
    if (e.boostKpa !== null && e.boostKpa < THRESHOLDS.lowBoostKpa) {
      any = true;
      hit(
        'Low boost at full throttle',
        ['power'],
        `${c}: boost ${e.boostKpa.toFixed(0)} kPa above atmospheric (below ${THRESHOLDS.lowBoostKpa} kPa)`,
        `${t(e.startMs)}: boost only ${e.boostKpa.toFixed(0)} kPa`,
      );
    }
    if (e.boostShortfallKpa !== null && e.boostShortfallKpa > THRESHOLDS.boostShortfallKpa) {
      any = true;
      hit(
        'Boost below its target',
        ['power'],
        `${c}: actual boost up to ${e.boostShortfallKpa.toFixed(0)} kPa below commanded`,
        `${t(e.startMs)}: boost up to ${e.boostShortfallKpa.toFixed(0)} kPa below target`,
      );
    }
    const r = e.timingRetard;
    if (r) {
      any = true;
      const min = Math.min(...r.samples.map((x) => x.deg));
      hit(
        'Ignition timing pulled back at full throttle',
        ['clatter', 'power'],
        `${c}: pedal held, no shift, ${r.samples.length} timing samples in a row ${r.samples.map((x) => `${x.deg.toFixed(1)}° at ${fmt(x.rpm, 'rpm')} (log median at similar rpm ${x.refDeg.toFixed(1)}°)`).join(', ')}, from ${t(r.startMs)}`,
        `${t(r.startMs)}: timing ${min.toFixed(1)}° at ${fmt(r.samples[0]!.rpm, 'rpm')}, ${THRESHOLDS.retardMarginDeg}° or more below this engine's usual full-load timing there`,
      );
    }
    if (e.railMinKpa !== null && e.railMinKpa < THRESHOLDS.lowRailKpa) {
      any = true;
      hit(
        'Low fuel rail pressure at full throttle',
        ['power', 'clatter'],
        `${c}: rail pressure down to ${e.railMinKpa.toFixed(0)} kPa (below ${THRESHOLDS.lowRailKpa} kPa)`,
        `${t(e.startMs)}: rail pressure ${e.railMinKpa.toFixed(0)} kPa`,
      );
    }
    if (!any)
      clean.push(
        `#${i + 1} at ${t(e.startMs)} ${fmt(e.speedStartKmh, 'km/h')} → ${fmt(e.speedEndKmh, 'km/h')}: full boost ${bracketText(e.fullBoostMs)} after pedal down, MAP ${fmt(e.mapPeakKpa, 'kPa')}, boost ${fmt(e.boostKpa, 'kPa')}, timing with the pedal held ${fmt(e.timingMinSteadyDeg, '°', 1)} min, rail ${fmt(e.railMinKpa, 'kPa')} min`,
      );
    if (!r && e.timingMinDeg !== null && e.timingMinDeg <= THRESHOLDS.knockRetardDeg) {
      const why = e.timingExcluded.map(
        (x) => `${x.deg.toFixed(1)}° at ${t(x.t)} (${x.why}, ${fmt(x.rpm, 'rpm')})`,
      );
      dips.push(
        `#${i + 1}: lowest ${e.timingMinDeg.toFixed(1)}°${why.length ? `; ${why.join(', ')}` : ''}; with the pedal held and no shift ${fmt(e.timingMinSteadyDeg, '°', 1)} min, not ${THRESHOLDS.retardMarginDeg}° below the log's full-load timing at that rpm for ${THRESHOLDS.retardMinSamples} samples in a row`,
      );
    }
  }
  for (const k of kinds.values()) {
    out.push({
      section: 'suspicious',
      title: k.title,
      severity: 'drivability',
      relates: k.relates,
      evidence: k.lines,
      jobCard: `Customer reports ${k.relates.map((x) => COMPLAINTS[x]).join(' and ')}; recorded in ${k.lines.length} full-throttle pull(s) during ${scenarioTitle}: ${k.jobs.join('; ')}. Please diagnose.`,
    });
  }
  if (clean.length)
    out.push({
      section: 'normal',
      title: `${clean.length} of ${s.throttleEvents.length} full-throttle pull(s) within the thresholds (${label})`,
      severity: 'minor',
      relates: [],
      evidence: [...clean, `PIDs sampled one at a time, about every 0.5-1.4 s: times are brackets`],
      jobCard: '',
    });
  if (dips.length)
    out.push({
      section: 'normal',
      title: `Full-throttle timing dips are shift / pedal-lift torque cuts or the base map, not knock retard (${label})`,
      severity: 'minor',
      relates: [],
      evidence: [
        ...dips,
        ...(s.fullLoadTiming.length
          ? [`full-load timing with the pedal held and no shift: ${timingBandsText(s.fullLoadTiming)}`]
          : []),
      ],
      jobCard: '',
    });
  if (s.lowRpmRetard.length) {
    const all = s.lowRpmRetard.flatMap((x) => x.samples);
    const worst = s.lowRpmRetard.reduce((a, x) => (x.minDeg < a.minDeg ? x : a));
    const rpms = all.map((x) => x.rpm);
    out.push({
      section: 'suspicious',
      title: 'Ignition timing pulled far back at low rpm under load',
      severity: 'drivability',
      relates: ['clatter'],
      evidence: [
        ...s.lowRpmRetard.map(
          (x) =>
            `${label}, ${t(x.startMs)}${x.endMs > x.startMs ? ` to ${t(x.endMs).replace(/^\S+ (\S+) UTC$/, '$1')}` : ''}: ${x.samples.map((p) => `${p.deg.toFixed(1)}° at ${p.rpm} rpm, load ${fmt(p.load, '%')}, MAP ${fmt(p.map, 'kPa')}, ${fmt(p.speed, 'km/h')}`).join('; ')}`,
        ),
        `rule: timing at or below ${THRESHOLDS.lowRpmRetardDeg}° below ${THRESHOLDS.lowRpmMax} rpm with load ≥ ${THRESHOLDS.lowRpmLoadPct} % or MAP ≥ ${THRESHOLDS.lowRpmMapKpa} kPa, coolant ${THRESHOLDS.lowRpmMinCoolantC} °C or warmer, not in the first ${THRESHOLDS.lowRpmAfterStartMs / 1000} s after a start; knock control or a planned torque reserve: generic OBD cannot tell them apart`,
      ],
      jobCard: `Customer reports ${COMPLAINTS.clatter}; during ${scenarioTitle} the ignition timing went down to ${worst.minDeg.toFixed(1)}° at ${Math.min(...rpms)}-${Math.max(...rpms)} rpm under load (${s.lowRpmRetard.length} time(s), e.g. ${t(worst.startMs)}). Please check the knock control values with the VW tester in the same conditions (low rpm, pulling away / creeping in D).`,
    });
  }
  for (const r of s.trimRuns) {
    out.push({
      section: 'suspicious',
      title: `Fuel trim ${r.key === 'ltft_b1' ? 'long' : 'short'}-term ${r.meanPct > 0 ? 'adding' : 'removing'} fuel`,
      severity: 'emissions',
      relates: r.meanPct > 0 ? ['power'] : [],
      evidence: [
        `${label}: ${r.key} ${r.meanPct} % for ${((r.endMs - r.startMs) / 1000).toFixed(0)} s from ${t(r.startMs)} (beyond ±${THRESHOLDS.trimPct} % for over ${THRESHOLDS.trimSustainMs / 1000} s)`,
      ],
      jobCard: `Engine mixture correction ${r.meanPct} % (${r.meanPct > 0 ? 'lean' : 'rich'}) sustained during ${scenarioTitle} on ${t(r.startMs)}; please check for air leaks / fuel delivery.`,
    });
  }
  if (Object.keys(s.trimMeans).length && !s.trimRuns.length) {
    out.push({
      section: 'normal',
      title: `Fuel trims within ±${THRESHOLDS.trimPct} % (${label})`,
      severity: 'minor',
      relates: [],
      evidence: [
        Object.entries(s.trimMeans)
          .map(([k, v]) => `${k} mean ${v} %`)
          .join(', '),
      ],
      jobCard: '',
    });
  }
  if (s.marks.length) {
    const lines = s.marks.map(
      (m) =>
        `${t(m.t)} "${m.note || 'mark'}": ${fmt(m.rpm, 'rpm')}, ${fmt(m.speed, 'km/h')}, load ${fmt(m.load, '%')}, timing ${fmt(m.timing, '°', 1)}, MAP ${fmt(m.map, 'kPa')}`,
    );
    const first = s.marks[0]!;
    out.push({
      section: 'suspicious',
      title: `Clatter heard ${s.marks.length} time(s) (${label})`,
      severity: 'drivability',
      relates: ['clatter'],
      evidence: lines,
      jobCard: `Customer reports ${COMPLAINTS.clatter}, heard ${s.marks.length} time(s) during ${scenarioTitle}, e.g. at ${fmt(first.rpm, 'rpm')} and ${fmt(first.speed, 'km/h')} with ${fmt(first.load, '%')} load; please road-test and diagnose.`,
    });
  }
  if (s.warmup?.coldStart) {
    const w = s.warmup;
    const slow = w.msToWarm === null && s.durationMs > 10 * 60_000;
    out.push({
      section: slow ? 'suspicious' : 'normal',
      title: slow ? 'Engine slow to warm up' : 'Cold-start warm-up recorded',
      severity: 'minor',
      relates: [],
      evidence: [
        `${label}: coolant ${fmt(w.startC, '°C')} → ${fmt(w.endC, '°C')}; ${w.points
          .slice(0, 8)
          .map((p) => `${p.s}s ${p.c}°C`)
          .join(', ')}`,
      ],
      jobCard: slow
        ? `Engine coolant did not reach ${THRESHOLDS.warmC} °C within ${Math.round(s.durationMs / 60000)} minutes from cold; please check the thermostat.`
        : '',
    });
  }
  return out;
}

const SOURCES_NOTE =
  'Thresholds are engineering heuristics, not manufacturer limits. Engine OBD code meanings are generic SAE descriptions; control unit DTCs are VW-internal numbers whose meaning needs the VW tester.';

const SECTIONS: readonly [Finding['section'], string][] = [
  ['confirmed', 'Confirmed faults'],
  ['suspicious', 'Suspicious readings'],
  ['normal', 'Looks normal'],
];
const SEVERITY_ORDER: Severity[] = ['safety', 'drivability', 'emissions', 'minor'];
const sorted = (fs: Finding[]) =>
  [...fs].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

export interface ReportInput {
  car: string;
  vin: string | null;
  odometer: string;
  takenAt: string;
  sources: string[];
  findings: Finding[];
  synthetic: boolean;
  /** The snapshot's read-only proof held (policy locked, nothing refused); absent counts as held (older callers). */
  readOnly?: boolean;
}

const readOnlyText = (r: ReportInput) =>
  r.readOnly === false
    ? 'read-only lock NOT confirmed for this snapshot: see its JSON'
    : 'read-only: nothing was cleared or changed';

export function reportMarkdown(r: ReportInput): string {
  const L: string[] = [];
  L.push('# Vehicle evidence for the service visit', '');
  L.push(`- Car: ${r.car}${r.vin ? `, VIN ${r.vin}` : ''}`);
  L.push(`- Odometer: ${r.odometer}`);
  L.push(`- Read on: ${when(r.takenAt)} (${readOnlyText(r)})`);
  if (r.synthetic) L.push('- **SYNTHETIC TEST DATA (fake bridge / simulator): not a real car.**');
  L.push('', '**Customer complaints**', '', `1. ${COMPLAINTS.clatter}`, `2. ${COMPLAINTS.power}`, '');
  for (const [section, title] of SECTIONS) {
    const fs = sorted(r.findings.filter((f) => f.section === section));
    L.push(`## ${title}`, '');
    if (!fs.length) L.push('- none', '');
    for (const f of fs) {
      if (section === 'normal') {
        L.push(`- ${f.title}${f.evidence.length ? ` (${f.evidence.join('; ')})` : ''}`);
        continue;
      }
      L.push(`### ${f.title}`, '');
      L.push(`- Severity: ${f.severity}; relates to: ${relatesText(f.relates)}`);
      for (const e of f.evidence) L.push(`- ${e}`);
      if (f.jobCard) L.push(`- Job card: _${f.jobCard}_`);
      L.push('');
    }
    if (section === 'normal') L.push('');
  }
  const cards = sorted(r.findings.filter((f) => f.jobCard && f.section !== 'normal'));
  L.push('## For the job card', '');
  if (!cards.length) L.push('- (no findings to write up)');
  for (const [i, f] of cards.entries()) L.push(`${i + 1}. ${f.jobCard}`);
  L.push(
    '',
    `Request: please record each item on the job card, and on the invoice state for each whether it was repaired (what part / what was done) or only cleared.`,
    '',
  );
  L.push(`Sources: ${r.sources.join(', ')}. ${SOURCES_NOTE}`);
  return `${L.join('\n')}\n`;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The same page as a standalone, printable HTML file (no scripts, no external resources). */
export function reportHtml(r: ReportInput): string {
  const parts: string[] = [];
  parts.push(`<h1>Vehicle evidence for the service visit</h1>`);
  parts.push(
    `<p class="meta">Car: ${esc(r.car)}${r.vin ? `, VIN ${esc(r.vin)}` : ''}<br>Odometer: ${esc(r.odometer)}<br>Read on: ${esc(when(r.takenAt))} (${esc(readOnlyText(r))})</p>`,
  );
  if (r.synthetic)
    parts.push('<p class="warn">SYNTHETIC TEST DATA (fake bridge / simulator): not a real car.</p>');
  parts.push(`<p><b>Customer complaints:</b> 1. ${esc(COMPLAINTS.clatter)}; 2. ${esc(COMPLAINTS.power)}</p>`);
  for (const [section, title] of SECTIONS) {
    const fs = sorted(r.findings.filter((f) => f.section === section));
    parts.push(`<h2>${esc(title)}</h2>`);
    if (!fs.length) parts.push('<p>none</p>');
    else if (section === 'normal')
      parts.push(
        `<ul>${fs.map((f) => `<li>${esc(f.title)}${f.evidence.length ? ` <span class="ev">(${esc(f.evidence.join('; '))})</span>` : ''}</li>`).join('')}</ul>`,
      );
    else
      for (const f of fs) {
        parts.push(
          `<div class="f ${f.severity}"><h3>${esc(f.title)} <span class="sev">${esc(f.severity)}</span></h3><p class="rel">Relates to: ${esc(relatesText(f.relates))}</p><ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${f.jobCard ? `<p class="job">Job card: ${esc(f.jobCard)}</p>` : ''}</div>`,
        );
      }
  }
  const cards = sorted(r.findings.filter((f) => f.jobCard && f.section !== 'normal'));
  parts.push('<h2>For the job card</h2>');
  parts.push(
    cards.length
      ? `<ol>${cards.map((f) => `<li>${esc(f.jobCard)}</li>`).join('')}</ol>`
      : '<p>(no findings to write up)</p>',
  );
  parts.push(
    '<p>Request: please record each item on the job card, and on the invoice state for each whether it was repaired (what part / what was done) or only cleared.</p>',
  );
  parts.push(`<p class="src">Sources: ${esc(r.sources.join(', '))}. ${esc(SOURCES_NOTE)}</p>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vehicle evidence</title>
<style>
body{font:13px/1.4 system-ui,sans-serif;color:#111;background:#fff;max-width:820px;margin:16px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;border-bottom:1px solid #999;margin:14px 0 6px}h3{font-size:13px;margin:0}
.meta,.src{color:#444}.warn{color:#a00;font-weight:bold}.f{border-left:4px solid #999;padding:4px 8px;margin:6px 0;break-inside:avoid}
.f.safety{border-color:#c00}.f.drivability{border-color:#d80}.f.emissions{border-color:#07a}.sev{font-weight:normal;color:#555;font-size:11px;text-transform:uppercase}
.rel{margin:2px 0;color:#333}.job{font-style:italic;margin:2px 0}ul,ol{margin:2px 0 2px 18px;padding:0}.ev{color:#555}
@media print{body{margin:0;font-size:11px}}
</style></head><body>
${parts.join('\n')}
</body></html>
`;
}
