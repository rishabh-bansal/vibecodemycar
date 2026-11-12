import type { HealthSnapshot } from './snapshot.ts';
import {
  type Field,
  faultClass,
  faultDtcs,
  UDS_DTC_MEANING,
  type UdsDtc,
  type UnitHealth,
  udsDtcLabel,
} from './uds.ts';

/**
 * Two health snapshots side by side (`live compare before.json after.json`), to tell a repair from a code clear:
 *
 *  - codes gone / new / still present, generic (stored, pending, permanent; SAE codes) and per unit (UDS DTC as its
 *    VW number, "VW 17142 (0x0042F6)", never an SAE code);
 *    a UDS entry counts only when it is a fault (status & 2D: failed, pending, confirmed, failed since the last
 *    clear), so an old snapshot's `19 02 FF` list ("test not completed" entries included) compares like a new one;
 *  - a code counts as gone only when the after snapshot read its source completely (the OBD list answered, the unit
 *    reachable with a whole fault list); a code missing from a source that was not fully re-read is "not re-read",
 *    never "gone";
 *  - evidence of a clear: PID 31 (distance), 30 (warm-ups) or 4E (minutes) since clear lower than before, or PID 31
 *    grown by clearly less than the odometer (both odometers recorded); a readiness monitor complete before and
 *    incomplete after; a UDS DTC whose frequency counter (extended record 02, VW layout, unverified) went down, whose
 *    snapshot mileage changed, or whose "test not completed since the last clear" bit is set after but was not
 *    before; several units that had DTCs listing none;
 *  - permanent (mode 0A) codes still present: only the ECU clears those, after the fault stopped recurring;
 *  - software changes: CALID / CVN, and per unit software version F189, hardware version F1A3, part number F187 and
 *    the rest of the identity — proof of a software update.
 *
 * A code that is gone while clear evidence exists is "cleared, fix not proven": the code went away because the memory
 * was erased, which says nothing about whether the cause was repaired. Only the same conditions re-run (the A-F log
 * scenarios) can show that. A code still present although its own memory shows a clear is "cleared and back": the
 * dealer cleared it and the fault returned, i.e. not fixed.
 */

/**
 * PID 31 may lag the owner's typed odometer by this much before the difference counts as a clear (cluster reading
 * rounded to the km, PID 31 counting whole km, a few km driven between reading and snapshot).
 */
export const CLEAR_DISTANCE_TOLERANCE_KM = 10;

export interface FaultDiff {
  source: string;
  code: string;
  meaning: string;
  status?: string;
}

export interface HealthComparison {
  schema: 'obdcraft.health-compare/1';
  before: { label: string; takenAt: string; odometerKm: number | null };
  after: { label: string; takenAt: string; odometerKm: number | null };
  sameCar: boolean | null;
  gone: FaultDiff[];
  added: FaultDiff[];
  still: FaultDiff[];
  /** Codes of the before snapshot whose source the after snapshot did not read completely: neither gone nor still. */
  notReread: FaultDiff[];
  clearEvidence: string[];
  permanentStill: FaultDiff[];
  softwareChanges: string[];
  /** Codes gone while clear evidence exists. */
  clearedNotProven: FaultDiff[];
  /** Codes still present although their memory shows a clear in between: cleared and came back, not fixed. */
  clearedAndBack: FaultDiff[];
  verdict: string;
}

const val = <T>(f: Field<T>): T | null => (f.status === 'ok' ? f.value : null);

function genericFaults(s: HealthSnapshot): Map<string, FaultDiff> {
  const out = new Map<string, FaultDiff>();
  for (const kind of ['stored', 'pending', 'permanent'] as const)
    for (const c of s.obd.dtcs[kind].codes)
      out.set(`obd:${kind}:${c.ecu}:${c.code}`, {
        source: `OBD ${kind} (${c.ecu})`,
        code: c.code,
        meaning: c.meaning,
      });
  return out;
}

/**
 * Why the snapshot cannot say a code of this key is absent (its source was not read completely), or null when the
 * source was read whole and a missing code really is gone.
 */
function notReadWhy(s: HealthSnapshot, key: string): string | null {
  const [kind, a] = key.split(':');
  if (kind === 'obd') {
    if (!s.obd.answered) return 'engine OBD-II not read';
    const list = s.obd.dtcs[a as 'stored' | 'pending' | 'permanent'];
    return list.status === 'ok' ? null : `OBD ${a} list ${list.status}`;
  }
  const unit = s.units.find((u) => u.request === a);
  if (!unit) return 'unit not in the unit list';
  if (!unit.reachable) return 'unit not reachable';
  if (unit.faults.status !== 'ok') return `fault list ${unit.faults.status}`;
  return null;
}

/** UDS faults by key; `every` takes the listed entries without a fault bit too (clear evidence only). */
function udsFaults(
  s: HealthSnapshot,
  every = false,
): Map<string, FaultDiff & { dtc: UdsDtc; unit: UnitHealth }> {
  const out = new Map<string, FaultDiff & { dtc: UdsDtc; unit: UnitHealth }>();
  for (const u of s.units)
    for (const d of every ? u.faults.dtcs : faultDtcs(u.faults))
      out.set(`uds:${u.request}:${d.dtcHex}`, {
        source: `unit ${u.unit} ${u.label}`,
        code: udsDtcLabel(d),
        meaning: UDS_DTC_MEANING,
        status: `${d.statusHex}${faultClass(d.status) ? ` ${faultClass(d.status)}` : ''}`,
        dtc: d,
        unit: u,
      });
  return out;
}

const strip = ({ source, code, meaning, status }: FaultDiff): FaultDiff => ({
  source,
  code,
  meaning,
  ...(status ? { status } : {}),
});

export function compareSnapshots(before: HealthSnapshot, after: HealthSnapshot): HealthComparison {
  const b = new Map<string, FaultDiff>([...genericFaults(before), ...udsFaults(before)]);
  const a = new Map<string, FaultDiff>([...genericFaults(after), ...udsFaults(after)]);
  const missing = [...b].filter(([k]) => !a.has(k));
  const gone = missing.filter(([k]) => notReadWhy(after, k) === null).map(([, f]) => strip(f));
  const notReread = missing
    .filter(([k]) => notReadWhy(after, k) !== null)
    .map(([k, f]) => ({ ...strip(f), status: `not re-read: ${notReadWhy(after, k)}` }));
  const added = [...a].filter(([k]) => !b.has(k)).map(([, f]) => strip(f));
  const stillKeys = [...a].filter(([k]) => b.has(k));
  const still = stillKeys.map(([k, f]) => {
    const old = b.get(k)?.status;
    return {
      ...strip(f),
      ...(old && f.status && old !== f.status ? { status: `${old} → ${f.status}` } : {}),
    };
  });

  const evidence: string[] = [];
  /** The engine's own clear evidence (PID counters, readiness): its codes still present were cleared and came back. */
  let engineCleared = false;
  /** UDS DTCs (key) whose own memory shows a clear. */
  const udsCleared = new Set<string>();
  const counter = (name: string, pid: string, x: Field<number>, y: Field<number>, unit: string) => {
    const vb = val(x);
    const va = val(y);
    if (vb !== null && va !== null && va < vb) {
      engineCleared = true;
      evidence.push(
        `PID ${pid} ${name} went down from ${vb}${unit} to ${va}${unit}: the fault memory was cleared in between`,
      );
    }
  };
  const cb = before.obd.counters;
  const ca = after.obd.counters;
  counter('distance since codes cleared', '31', cb.distanceSinceClearKm, ca.distanceSinceClearKm, ' km');
  counter('warm-ups since codes cleared', '30', cb.warmupsSinceClear, ca.warmupsSinceClear, '');
  counter('time since codes cleared', '4E', cb.minutesSinceClear, ca.minutesSinceClear, ' min');
  // Cleared, then driven past the old value: PID 31 grew by clearly less than the car drove. PID 31 saturates at
  // 65535 km, so a saturated before value proves nothing.
  const d31b = val(cb.distanceSinceClearKm);
  const d31a = val(ca.distanceSinceClearKm);
  const odoB = before.odometer.km;
  const odoA = after.odometer.km;
  if (d31b !== null && d31a !== null && d31a >= d31b && d31b < 65535 && odoB !== null && odoA !== null) {
    const driven = odoA - odoB;
    const grew = d31a - d31b;
    if (driven >= 0 && grew < driven - CLEAR_DISTANCE_TOLERANCE_KM) {
      engineCleared = true;
      evidence.push(
        `PID 31 distance since codes cleared grew by ${grew} km (${d31b} → ${d31a}) while the odometer grew by ${driven} km (${odoB} → ${odoA}, ${before.odometer.source} / ${after.odometer.source}): the fault memory was cleared in between, about ${d31a} km ago`,
      );
    }
  }
  const mb = val(before.obd.monitors) ?? [];
  const ma = val(after.obd.monitors) ?? [];
  for (const m of ma) {
    const was = mb.find((x) => x.name === m.name);
    if (was?.status === 'complete' && m.status === 'incomplete') {
      engineCleared = true;
      evidence.push(
        `readiness monitor "${m.name}" was complete and is now incomplete (monitors reset when codes are cleared)`,
      );
    }
  }
  // A fault of before whose entry after (fault or not) shows a clear.
  const ub = udsFaults(before);
  for (const [key, f] of udsFaults(after, true)) {
    const was = ub.get(key);
    if (!was) continue;
    const NOT_DONE = 0x10;
    if (f.dtc.status & NOT_DONE && !(was.dtc.status & NOT_DONE)) {
      udsCleared.add(key);
      evidence.push(
        `${f.source} ${f.code}: "test not completed since the last clear" is set now and was not before`,
      );
    }
    // Only the frequency counter (record 02 in the common VW layout): the other records, such as the unlearning
    // counter, change on their own while a fault does not recur.
    const freq = (d: UdsDtc) => d.extended?.records?.find((r) => r.record === 0x02)?.value;
    const fOld = freq(was.dtc);
    const fNew = freq(f.dtc);
    if (fOld !== undefined && fNew !== undefined && fNew < fOld) {
      udsCleared.add(key);
      evidence.push(
        `${f.source} ${f.code}: extended record 02 (malfunction frequency counter, unverified) went down from ${fOld} to ${fNew}`,
      );
    }
    const mileage = (d: UdsDtc) =>
      d.snapshot?.records?.flatMap((r) => r.values).find((v) => v.did === '2002')?.value;
    const mOld = mileage(was.dtc);
    const mNew = mileage(f.dtc);
    if (typeof mOld === 'number' && typeof mNew === 'number' && mNew !== mOld) {
      udsCleared.add(key);
      evidence.push(
        `${f.source} ${f.code}: snapshot mileage (unverified) changed from ${mOld} to ${mNew} km: the fault was stored again`,
      );
    }
  }
  // Many UDS units at once without the DTCs they had before: a whole-car clear (a gateway "clear all").
  const emptied = before.units.filter(
    (u) =>
      faultDtcs(u.faults).length &&
      after.units.some(
        (x) =>
          x.request === u.request && x.reachable && x.faults.status === 'ok' && !faultDtcs(x.faults).length,
      ),
  );
  const clearAll = emptied.length >= 2;
  if (clearAll)
    evidence.push(
      `${emptied.length} units that had DTCs now list none (${emptied.map((u) => u.unit).join(', ')}): consistent with a clear of every unit`,
    );
  const clearedAndBack = stillKeys
    // Permanent codes survive a tester clear by design: they are listed on their own, not as "came back".
    .filter(([k]) => !k.startsWith('obd:permanent:'))
    .filter(([k]) => (k.startsWith('obd:') ? engineCleared : udsCleared.has(k) || clearAll))
    .map(([, f]) => strip(f));

  const permanentStill = after.obd.dtcs.permanent.codes.map((c) => ({
    source: `OBD permanent (${c.ecu})`,
    code: c.code,
    meaning: c.meaning,
  }));

  const software: string[] = [];
  // Sorted: the ECUs answer in no fixed order, which is no change.
  const list = (f: Field<string[]>) => (f.status === 'ok' ? [...f.value].sort().join('; ') : null);
  for (const [name, x, y] of [
    ['calibration ID (CALID)', before.obd.calid, after.obd.calid],
    ['calibration verification number (CVN)', before.obd.cvn, after.obd.cvn],
  ] as const) {
    const vb = list(x);
    const va = list(y);
    if (vb !== null && va !== null && vb !== va)
      software.push(`engine ${name} changed: ${vb} → ${va} (software update)`);
  }
  for (const u of after.units) {
    const was = before.units.find((x) => x.request === u.request);
    if (!was?.reachable || !u.reachable) continue;
    for (const [field, value] of Object.entries(u.identity)) {
      const old = was.identity[field];
      if (old?.status === 'ok' && value.status === 'ok' && old.value !== value.value) {
        software.push(
          `unit ${u.unit} ${u.label} ${field} changed: ${old.value} → ${value.value}${field === 'software' ? ' (software update)' : field === 'part' || field === 'hardware' ? ' (part replaced or recoded)' : ''}`,
        );
      }
    }
  }

  const clearedNotProven = evidence.length ? gone : [];
  const vinB = val(before.obd.vin) ?? before.car.vin;
  const vinA = val(after.obd.vin) ?? after.car.vin;
  const sameCar = vinB && vinA ? vinB === vinA : null;
  const main =
    !gone.length && !added.length
      ? still.length
        ? `Nothing was fixed: all ${still.length} code(s) are still present.`
        : notReread.length
          ? 'No code is proven gone: the after snapshot did not re-read every source.'
          : 'No codes before or after.'
      : evidence.length
        ? `${gone.length} code(s) gone, but the fault memory was cleared in between: gone codes are "cleared, fix not proven" until the same conditions are re-run without them coming back.`
        : gone.length
          ? `${gone.length} code(s) gone with no sign of a clear: they went away on their own or after a repair; re-run the scenarios to confirm.`
          : `${added.length} new code(s); none gone.`;
  const verdict = [
    sameCar === false ? 'WARNING: the two snapshots are of different cars (VIN differs).' : null,
    main,
    clearedAndBack.length ? `${clearedAndBack.length} code(s) were cleared and came back (not fixed).` : null,
    notReread.length
      ? `${notReread.length} code(s) not re-read in the after snapshot (neither gone nor still).`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    schema: 'obdcraft.health-compare/1',
    before: { label: before.label, takenAt: before.takenAt, odometerKm: before.odometer.km },
    after: { label: after.label, takenAt: after.takenAt, odometerKm: after.odometer.km },
    sameCar,
    gone,
    added,
    still,
    notReread,
    clearEvidence: evidence,
    permanentStill,
    softwareChanges: software,
    clearedNotProven,
    clearedAndBack,
    verdict,
  };
}

export function comparisonMarkdown(c: HealthComparison): string {
  const L: string[] = [];
  const f = (d: FaultDiff) =>
    `- ${d.source}: **${d.code}**${d.status ? ` (status ${d.status})` : ''} ${d.meaning}`;
  L.push(`# Before / after: ${c.before.label} → ${c.after.label}`, '');
  L.push(`- Before: ${c.before.takenAt}, odometer ${c.before.odometerKm ?? 'not recorded'}`);
  L.push(`- After: ${c.after.takenAt}, odometer ${c.after.odometerKm ?? 'not recorded'}`);
  L.push(
    `- Same car (VIN): ${c.sameCar === null ? 'not known (VIN missing in one snapshot)' : c.sameCar ? 'yes' : '**NO: the snapshots are of different cars**'}`,
  );
  L.push('', `**${c.verdict}**`, '');
  L.push('## Codes gone', '', ...(c.gone.length ? c.gone.map(f) : ['- none']), '');
  L.push('## New codes', '', ...(c.added.length ? c.added.map(f) : ['- none']), '');
  L.push('## Still present', '', ...(c.still.length ? c.still.map(f) : ['- none']), '');
  L.push(
    '## Not re-read (the after snapshot could not read their source)',
    '',
    ...(c.notReread.length ? c.notReread.map(f) : ['- none']),
    '',
  );
  L.push(
    '## Evidence the fault memory was cleared',
    '',
    ...(c.clearEvidence.length ? c.clearEvidence.map((e) => `- ${e}`) : ['- none found']),
    '',
  );
  L.push(
    '## Cleared but not proven fixed',
    '',
    ...(c.clearedNotProven.length ? c.clearedNotProven.map(f) : ['- none']),
    '',
  );
  L.push(
    '## Cleared and came back (not fixed)',
    '',
    ...(c.clearedAndBack.length ? c.clearedAndBack.map(f) : ['- none']),
    '',
  );
  L.push(
    '## Permanent codes (mode 0A) still present',
    '',
    ...(c.permanentStill.length ? c.permanentStill.map(f) : ['- none']),
    '',
  );
  L.push(
    '## Software / part changes',
    '',
    ...(c.softwareChanges.length ? c.softwareChanges.map((s) => `- ${s}`) : ['- none']),
    '',
  );
  return `${L.join('\n')}\n`;
}
