import type { ObdSection } from './obd.ts';
import type { Field, UdsDtc, UdsDtcList, UnitHealth } from './uds.ts';
import {
  DTC_STATUS_BITS,
  faultClass,
  faultDtcs,
  UDS_DTC_MEANING,
  udsDtcLabel,
  udsDtcRemark,
  udsDtcText,
} from './uds.ts';

/**
 * One read-only evidence snapshot of the car (`live health`): the generic OBD-II scan and every reachable unit's UDS
 * fault memory, timestamped, with the odometer and the conditions it was taken in. Saved as JSON (the evidence) and
 * Markdown (to read and print); `live compare` diffs two of them and `live report` turns one into the advisor's page.
 */

export const HEALTH_SCHEMA = 'obdcraft.health/1';

export interface HealthSnapshot {
  schema: typeof HEALTH_SCHEMA;
  label: string;
  takenAt: string;
  finishedAt: string;
  /** Odometer: PID A6 when the ECU has it, else what the owner typed (--odometer), else not recorded. */
  odometer: { km: number | null; source: 'PID A6' | '--odometer' | 'not recorded' };
  car: { vin: string | null; adapter: string | null; voltage: string | null; synthetic: boolean };
  obd: ObdSection;
  units: UnitHealth[];
  /** Units of the unit list that did not answer at all. */
  notReachable: { unit: string; label: string; request: string }[];
  /** Read-only proof: the policy lock held for the whole run and the requests it refused (should be none). */
  readOnly: { locked: boolean; refused: string[] };
  notes: string[];
}

export function chooseOdometer(obd: ObdSection, typed: number | undefined): HealthSnapshot['odometer'] {
  const a6 = obd.counters.odometerKm;
  if (a6.status === 'ok') return { km: a6.value, source: 'PID A6' };
  if (typed !== undefined && Number.isFinite(typed) && typed >= 0)
    return { km: Math.round(typed), source: '--odometer' };
  return { km: null, source: 'not recorded' };
}

/** A file-name-safe label: baseline, after, or the owner's text. */
export function labelSlug(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'snapshot'
  );
}

export const fieldText = <T>(f: Field<T>, show: (v: T) => string = String): string =>
  f.status === 'ok' ? show(f.value) : `${f.status} (${f.why})`;

const statusText = (d: UdsDtc) =>
  d.statusBits.map((id) => DTC_STATUS_BITS.find((b) => b.id === id)?.text ?? id).join(', ') ||
  'no status bit set';

/**
 * Every fault of the snapshot, generic and per unit, in one flat list (for compare and report). UDS entries without a
 * fault bit (status & 2D = 0: only "test not completed" and the like) are not faults and are left out; they stay in
 * the JSON.
 */
export function allFaults(s: HealthSnapshot): { source: string; code: string; detail: string }[] {
  const out: { source: string; code: string; detail: string }[] = [];
  for (const kind of ['stored', 'pending', 'permanent'] as const)
    for (const c of s.obd.dtcs[kind].codes)
      out.push({ source: `OBD ${kind} (${c.ecu})`, code: c.code, detail: c.meaning });
  for (const u of s.units)
    for (const d of faultDtcs(u.faults))
      out.push({
        source: `unit ${u.unit} ${u.label}`,
        code: udsDtcLabel(d),
        detail: `${faultClass(d.status)}, ${statusText(d)}; ${UDS_DTC_MEANING}`,
      });
  return out;
}

/** The listed entries that are not faults, counted by status byte: "10 ×144, 40 ×2". */
export function nonFaultText(f: UdsDtcList): string | null {
  const counts = new Map<string, number>();
  for (const d of f.dtcs)
    if (!faultClass(d.status)) counts.set(d.statusHex, (counts.get(d.statusHex) ?? 0) + 1);
  if (!counts.size) return null;
  const n = [...counts.values()].reduce((a, b) => a + b, 0);
  return `${n} entr${n === 1 ? 'y' : 'ies'} without a fault bit (not faults; status ${[...counts]
    .sort()
    .map(([h, c]) => `${h} ×${c}`)
    .join(', ')})`;
}

/** "unit counts 52 entries with any status bit, 3 faults" from the 19 01 answers, or ''. */
const countText = (f: UdsDtcList) =>
  [
    f.count !== null ? `unit counts ${f.count} entries with any status bit` : null,
    f.faultCount != null ? `${f.faultCount} fault(s) (19 01 2D)` : null,
  ]
    .filter(Boolean)
    .join(', ');

function dtcBlock(d: UdsDtc): string[] {
  const lines = [
    `- **${udsDtcLabel(d)}** ${faultClass(d.status) ?? 'not a fault'}, status ${d.statusHex}: ${statusText(d)}. ${UDS_DTC_MEANING}${udsDtcRemark(d) ? `; ${udsDtcRemark(d)}` : ''}`,
  ];
  if (d.snapshot) {
    const vals = (d.snapshot.records ?? []).flatMap((r) =>
      r.values.map(
        (v) =>
          `${v.name ?? `DID ${v.did}`} ${v.value !== undefined ? `${v.value}${v.unit ? ` ${v.unit}` : ''}` : v.hex}${v.unverified ? ' (unverified)' : ''}`,
      ),
    );
    lines.push(
      `  - snapshot (19 04): ${d.snapshot.status}${vals.length ? `; ${vals.join('; ')}` : ''}${d.snapshot.note ? `; ${d.snapshot.note}` : ''}${d.snapshot.raw ? `; raw ${d.snapshot.raw}` : ''}`,
    );
  }
  if (d.extended) {
    const vals = (d.extended.records ?? []).map(
      (r) =>
        `record ${r.record.toString(16).toUpperCase().padStart(2, '0')}${r.name ? ` ${r.name}` : ''} = ${r.value ?? r.hex}${r.unverified ? ' (unverified)' : ''}`,
    );
    lines.push(
      `  - extended data (19 06): ${d.extended.status}${vals.length ? `; ${vals.join('; ')}` : ''}${d.extended.note ? `; ${d.extended.note}` : ''}${d.extended.raw ? `; raw ${d.extended.raw}` : ''}`,
    );
  }
  return lines;
}

/** The snapshot as Markdown: every value with its source, everything not read said so. */
export function healthMarkdown(s: HealthSnapshot): string {
  const o = s.obd;
  const L: string[] = [];
  L.push(`# Car health snapshot: ${s.label}`, '');
  L.push(`- Taken: ${s.takenAt} (finished ${s.finishedAt})`);
  L.push(
    `- Odometer: ${s.odometer.km !== null ? `${s.odometer.km} km` : 'not recorded'} (source: ${s.odometer.source})`,
  );
  L.push(`- VIN: ${s.car.vin ?? 'not read'}`);
  L.push(`- Adapter: ${s.car.adapter ?? 'unknown'}, battery ${s.car.voltage ?? 'not read'}`);
  L.push(
    `- Read-only: ${s.readOnly.locked ? 'send policy locked to reads for the whole run' : 'NOT LOCKED'}; requests refused: ${s.readOnly.refused.length ? s.readOnly.refused.join(', ') : 'none'}`,
  );
  if (s.car.synthetic) L.push('- **Synthetic run (fake bridge / simulator): not a real car.**');
  for (const n of s.notes) L.push(`- ${n}`);
  L.push('', '## Engine (generic OBD-II)', '');
  if (!o.answered) L.push(`Not read: ${o.note}`, '');
  else {
    L.push(`- ECUs: ${o.ecus.map((e) => `${e.id} (${e.role}${e.name ? `, ${e.name}` : ''})`).join(', ')}`);
    L.push(`- ECU name: ${fieldText(o.ecuName, (v) => v.join('; '))}`);
    L.push(`- Calibration ID (CALID): ${fieldText(o.calid, (v) => v.join('; '))}`);
    L.push(`- Calibration verification number (CVN): ${fieldText(o.cvn, (v) => v.join('; '))}`);
    L.push(
      `- Check-engine light (MIL): ${fieldText(o.mil, (v) => (v ? 'ON' : 'off'))}; confirmed codes reported: ${fieldText(o.dtcCount)}`,
    );
    L.push(`- Distance with MIL on (PID 21): ${fieldText(o.counters.distanceWithMilKm, (v) => `${v} km`)}`);
    L.push(`- Warm-ups since codes cleared (PID 30): ${fieldText(o.counters.warmupsSinceClear)}`);
    L.push(
      `- Distance since codes cleared (PID 31): ${fieldText(o.counters.distanceSinceClearKm, (v) => `${v} km`)}`,
    );
    L.push(`- Time with MIL on (PID 4D): ${fieldText(o.counters.minutesWithMil, (v) => `${v} min`)}`);
    L.push(
      `- Time since codes cleared (PID 4E): ${fieldText(o.counters.minutesSinceClear, (v) => `${v} min`)}`,
    );
    L.push(`- Odometer (PID A6): ${fieldText(o.counters.odometerKm, (v) => `${v} km`)}`);
    L.push('', '### Readiness monitors', '');
    if (o.monitors.status === 'ok')
      for (const m of o.monitors.value)
        L.push(`- ${m.name}${m.continuous ? ' (continuous)' : ''}: ${m.status}`);
    else L.push(`- ${fieldText(o.monitors)}`);
    L.push('', '### Fault codes', '');
    for (const kind of ['stored', 'pending', 'permanent'] as const) {
      const list = o.dtcs[kind];
      const mode = kind === 'stored' ? '03' : kind === 'pending' ? '07' : '0A';
      if (list.status !== 'ok') L.push(`- ${kind} (mode ${mode}): ${list.status}`);
      else if (!list.codes.length) L.push(`- ${kind} (mode ${mode}): none`);
      else
        for (const c of list.codes) L.push(`- ${kind} (mode ${mode}) ${c.ecu}: **${c.code}** ${c.meaning}`);
    }
    L.push('', '### Freeze frame (mode 02)', '');
    if (!o.freezeFrames.length) L.push('- none stored');
    for (const f of o.freezeFrames) {
      L.push(`- ${f.ecu}: stored by **${f.dtc}** (${f.meaning})`);
      for (const v of f.values) L.push(`  - ${v.name}: ${v.value ?? 'n/a'}${v.unit ? ` ${v.unit}` : ''}`);
    }
    L.push('', '### Self-test results (mode 06)', '');
    if (o.tests.status !== 'ok') L.push(`- ${fieldText(o.tests)}`);
    else {
      const shown = o.tests.value.filter((t) => t.highlight || !t.passed);
      L.push(
        `${o.tests.value.length} results; ${o.tests.value.filter((t) => !t.passed).length} outside limits. Misfire, catalyst, oxygen sensor and failed tests:`,
        '',
      );
      L.push('| ECU | MID | test | value | min | max | result | part |', '|---|---|---|---|---|---|---|---|');
      for (const t of shown) {
        L.push(
          `| ${t.ecu} | ${t.mid} ${t.midName} | ${t.tid} ${t.tidName} | ${t.value}${t.unit ? ` ${t.unit}` : ''} | ${t.min} | ${t.max} | ${t.passed ? 'pass' : '**FAIL**'}${t.saturated ? ' (saturated: test may not have run)' : ''} | ${t.highlight ?? ''} |`,
        );
      }
    }
    for (const i of o.testIssues) L.push(`- not read: ${i}`);
    if (o.readings.length) {
      L.push('', '### Conditions at snapshot time (mode 01)', '');
      for (const r of o.readings)
        L.push(`- ${r.ecu} PID ${r.pid} ${r.name}: ${r.value ?? 'n/a'}${r.unit ? ` ${r.unit}` : ''}`);
    }
  }
  L.push('', '## Control units (UDS)', '');
  for (const u of s.units) {
    if (!u.reachable) continue;
    L.push(`### Unit ${u.unit} ${u.label} (${u.request}/${u.response})`, '');
    for (const [field, value] of Object.entries(u.identity)) L.push(`- ${field}: ${fieldText(value)}`);
    const f = u.faults;
    const faults = faultDtcs(f);
    const counted = countText(f);
    L.push(
      `- fault memory: ${f.status}${f.listMask ? `, listed with mask ${f.listMask}` : ', listed with mask FF (every status bit; filtered to faults here)'}${counted ? `, ${counted}` : ''}${f.availabilityMask ? `, status availability mask ${f.availabilityMask}` : ''}`,
    );
    for (const n of f.notes) L.push(`- note: ${n}`);
    if (!faults.length && (f.status === 'ok' || f.status === 'partial')) L.push('- no faults listed');
    for (const d of faults) L.push(...dtcBlock(d));
    const other = nonFaultText(f);
    if (other) L.push(`- also listed: ${other}; kept in the JSON`);
    if (f.raw.length) L.push(`- raw: ${f.raw.join(' | ')}`);
    L.push('');
  }
  L.push('## Not reachable', '');
  if (!s.notReachable.length) L.push('- none');
  for (const u of s.notReachable) L.push(`- unit ${u.unit} ${u.label} (${u.request}): not reachable`);
  L.push(
    '',
    'Engine OBD codes (modes 03 / 07 / 0A) are SAE codes with the generic SAE description from the built-in table; manufacturer-specific codes are not guessed. Control unit (UDS) DTCs are VW-internal numbers ("VW <decimal> (0x<hex>)"): they are not SAE codes and their meaning needs the workshop tester. Decodings marked "unverified" follow common VW documentation and are not confirmed.',
  );
  return `${L.join('\n')}\n`;
}

/** A few lines for the terminal and the cloud log. */
export function healthSummary(s: HealthSnapshot): string[] {
  const o = s.obd;
  const lines = [
    `${s.label} at ${s.takenAt}; odometer ${s.odometer.km ?? 'not recorded'}${s.odometer.km !== null ? ' km' : ''} (${s.odometer.source})`,
    o.answered
      ? `engine: MIL ${fieldText(o.mil, (v) => (v ? 'ON' : 'off'))}; codes stored ${o.dtcs.stored.codes.length}, pending ${o.dtcs.pending.codes.length}, permanent ${o.dtcs.permanent.status === 'ok' ? o.dtcs.permanent.codes.length : o.dtcs.permanent.status}; freeze frames ${o.freezeFrames.length}; mode 06 ${o.tests.status === 'ok' ? `${o.tests.value.filter((t) => !t.passed).length} of ${o.tests.value.length} outside limits` : o.tests.status}`
      : `engine: not read (${o.note})`,
    `since clear: ${fieldText(o.counters.distanceSinceClearKm, (v) => `${v} km`)}, ${fieldText(o.counters.warmupsSinceClear, (v) => `${v} warm-ups`)}, ${fieldText(o.counters.minutesSinceClear, (v) => `${v} min`)}`,
  ];
  const reached = s.units.filter((u) => u.reachable);
  const others = reached.reduce((n, u) => n + u.faults.dtcs.length - faultDtcs(u.faults).length, 0);
  lines.push(
    `units: ${reached.length} reachable, ${s.notReachable.length} not reachable; UDS faults ${reached.reduce((n, u) => n + faultDtcs(u.faults).length, 0)}${others ? ` (plus ${others} listed entries without a fault bit, not faults)` : ''}`,
  );
  for (const u of reached) {
    const faults = faultDtcs(u.faults);
    if (faults.length || u.faults.status !== 'ok') {
      lines.push(
        `unit ${u.unit} ${u.label}: ${u.faults.status}, ${faults.map((d) => `${udsDtcText(d)} (${d.statusHex})`).join(', ') || 'no faults'}${u.faults.notes.length ? `; ${u.faults.notes[0]}` : ''}`,
      );
    }
  }
  return lines;
}
