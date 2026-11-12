import {
  Elm327Emulator,
  kushaqLikeSpecs,
  OBDCraftEngine,
  PolicyError,
  runVirtual,
  SafetyPolicy,
  StandardEcu,
  VirtualClock,
} from '@obdcraft/obd-core';
import { describe, expect, it } from 'vitest';
import {
  answerReadDtc,
  BCM_FAULTS,
  CLUSTER_FAULTS,
  faultyEngineSpec,
} from '../../infra/link/testing/health-car.ts';
import { compareSnapshots, comparisonMarkdown } from './compare.ts';
import {
  columnsFor,
  csvHeader,
  csvMeta,
  csvRow,
  type LogFile,
  type LogRow,
  parseLogCsv,
  parsePidList,
  selectPids,
  summarizeLog,
  THRESHOLDS,
} from './livelog.ts';
import { obdSection } from './obd.ts';
import { assertHealthRequest, HealthReadOnlyViolation, isHealthRequest } from './readonly.ts';
import { healthFindings, logFindings, mergeFindings, reportHtml, reportMarkdown } from './report.ts';
import {
  allFaults,
  chooseOdometer,
  HEALTH_SCHEMA,
  type HealthSnapshot,
  healthMarkdown,
  healthSummary,
} from './snapshot.ts';
import {
  decodeDtcStatus,
  FAULT_STATUS_MASK,
  faultClass,
  faultDtcs,
  isFaultStatus,
  parseDtcList,
  parseExtended,
  parseSnapshot,
  readUnitHealth,
  SPLIT_MASKS,
  UDS_DTC_MEANING,
  type UdsAnswer,
  udsDtcLabel,
  udsDtcOf,
  udsDtcText,
} from './uds.ts';

const hex = (s: string) => (s.replace(/\s+/g, '').match(/../g) ?? []).map((b) => Number.parseInt(b, 16));

describe('read-only guard', () => {
  const refused: [string, string][] = [
    ['04', 'clear codes'],
    ['14 FF FF FF', 'clear DTC information'],
    ['2E F1 98 01 02 03 04 05 06', 'write'],
    ['2F 05 03 03 00', 'IO control'],
    ['31 01 02 03', 'routine'],
    ['27 03', 'security access'],
    ['11 01', 'reset'],
    ['10 02', 'programming session'],
    ['28 00 01', 'communication control'],
    ['85 02', 'DTC setting off'],
    ['19 05 01', 'unlisted 19 sub-function'],
    ['19 14', 'unlisted 19 sub-function'],
    ['19 02', '19 02 without a mask'],
    ['08 01', 'running an on-board test'],
    ['22 F1 87 F1 89', 'multi-identifier read'],
  ];
  for (const [req, what] of refused) {
    it(`refuses ${req} (${what}) before anything is sent`, () => {
      expect(isHealthRequest(hex(req))).toBe(false);
      expect(() => assertHealthRequest(hex(req))).toThrow(HealthReadOnlyViolation);
    });
  }

  it('allows exactly the health reads', () => {
    for (const req of [
      '19 01 FF',
      '19 01 2D',
      '19 02 FF',
      '19 02 2D',
      '19 02 08',
      '19 02 20',
      '19 03',
      '19 04 C1 00 00 FF',
      '19 06 C1 00 00 FF',
      '19 0A',
      '01 00',
      '01 0C 0D 49',
      '02 02 00',
      '03',
      '07',
      '0A',
      '05 01 01',
      '06 A2',
      '08 00',
      '09 02',
      '22 F1 87',
      '3E 00',
      '10 03',
    ])
      expect(isHealthRequest(hex(req)), req).toBe(true);
  });

  it('names the refused service in the error', () => {
    expect(() => assertHealthRequest([0x14, 0xff, 0xff, 0xff])).toThrow(/clears the fault memory/);
    expect(() => assertHealthRequest([0x04])).toThrow(/clears the fault codes/);
  });
});

describe('send policy health lock', () => {
  const can = { family: 'can11' as const, target: '714' };

  it('refuses 04, 14, 2E, 2F, 31, 27, 11, 10 02, 28 and 85 while held, even with a clear token issued before', () => {
    const policy = new SafetyPolicy(() => 0);
    const token = policy.issueClearToken();
    const release = policy.enterHealthReadOnly();
    expect(() => policy.check('04', { family: 'can11' }, token)).toThrow(PolicyError);
    for (const c of [
      '14FFFFFF',
      '2EF198010203040506',
      '2F05030300',
      '31010203',
      '2703',
      '1101',
      '1002',
      '280001',
      '8502',
    ])
      expect(() => policy.check(c, can), c).toThrow(PolicyError);
    expect(() => policy.issueClearToken()).toThrow(/health snapshot/);
    expect(() => policy.issueCodingPermit('714', { writes: ['2E0E4631'] })).toThrow(/health snapshot/);
    release();
    // released: the clear token still was never usable in between, and permits work again
    expect(() => policy.issueCodingPermit('714', { writes: ['2E0E4631'] })).not.toThrow();
  });

  it('lets the health reads through, still under the ordinary rules', () => {
    const policy = new SafetyPolicy(() => 0);
    policy.enterHealthReadOnly();
    for (const c of [
      '1901FF',
      '1902FF',
      '1904C10000FF',
      '1906C10000FF',
      '22F187',
      '0100',
      '010C0D',
      '03',
      '07',
      '0A',
      '06A2',
      '0800',
      '0902',
      '020200',
      '3E00',
      '1003',
    ])
      expect(() => policy.check(c, can), c).not.toThrow();
    // 05 stays refused on CAN, 08 only lists
    expect(() => policy.check('050101', can)).toThrow(PolicyError);
    expect(() => policy.check('0801', can)).toThrow(PolicyError);
    // and STPX cannot carry what the lock refuses
    expect(() => policy.check('STPX h:714,d:14FFFFFF,r:1', can)).toThrow(PolicyError);
  });
});

describe('UDS fault memory parsing', () => {
  it('decodes every status bit', () => {
    expect(decodeDtcStatus(0x2f)).toEqual([
      'testFailed',
      'testFailedThisOperationCycle',
      'pendingDTC',
      'confirmedDTC',
      'testFailedSinceLastClear',
    ]);
    expect(decodeDtcStatus(0x80)).toEqual(['warningIndicatorRequested']);
  });

  it('takes only whole records from a partial list and skips filler', () => {
    const list = parseDtcList(hex('59 02 FF C1 00 00 28 9A 13 11 24 AA AA AA AA 01 02'));
    expect(list?.dtcs.map((d) => `${udsDtcLabel(d)}:${d.statusHex}`)).toEqual([
      'VW 12648448 (0xC10000):28',
      'VW 10097425 (0x9A1311):24',
    ]);
    // Never an SAE reading ("U0100 lost communication…") for a VW unit's DTC.
    expect(list?.dtcs[0]?.meaning).toBe(UDS_DTC_MEANING);
    expect(list?.dtcs[1]?.code).toBe('VW 10097425');
  });

  it('shows VW DTC numbers the way VW testers do, old snapshots included', () => {
    // live 2026-11-09: engine 00 42 F6 status 20 (our tool printed "P0042-F6")
    const d = udsDtcOf([0x00, 0x42, 0xf6, 0x20]);
    expect(udsDtcText(d)).toBe('VW 17142 (0x0042F6) failed since the last clear');
    expect(udsDtcText(udsDtcOf([0x04, 0x05, 0x12, 0x08]))).toBe('VW 263442 (0x040512) confirmed');
    expect(udsDtcLabel({ dtcHex: '823002' })).toBe('VW 8531970 (0x823002)');
    // An old snapshot's entry still carries the SAE reading in `code` / `meaning`: display ignores them.
    const old = { ...d, code: 'P0042', meaning: 'meaning: unknown (generic code not in the built-in table)' };
    expect(udsDtcText(old)).toBe('VW 17142 (0x0042F6) failed since the last clear');
  });

  it('splits a snapshot by known identifiers and keeps the rest raw', () => {
    const recs = parseSnapshot(answerReadDtc(hex('19 04 C1 00 00 FF'), BCM_FAULTS));
    expect(recs?.[0]?.values).toMatchObject([
      { did: '2002', value: 27000, unit: 'km', unverified: true },
      { did: 'F40C', value: 750, unit: 'rpm' },
      { did: 'F40D', value: 0 },
    ]);
    const unknown = parseSnapshot(hex('59 04 C1 00 00 28 01 02 12 34 AA BB F4 0D 00'));
    expect(unknown?.[0]).toMatchObject({ values: [], undecodedHex: '1234AABBF40D00' });
  });

  it('reads one-byte extended records as the VW layout (unverified), anything else raw', () => {
    expect(parseExtended(answerReadDtc(hex('19 06 C1 00 00 FF'), BCM_FAULTS))).toEqual([
      { record: 1, hex: '02', value: 2, name: 'priority', unverified: true },
      { record: 2, hex: '05', value: 5, name: 'malfunction frequency counter', unverified: true },
      { record: 3, hex: 'FE', value: 254, name: 'unlearning counter', unverified: true },
    ]);
    expect(parseExtended(hex('59 06 C1 00 00 28 02 00 00 03'))).toEqual([{ record: 2, hex: '000003' }]);
  });
});

/** A fake unit: answers from a fault list, optionally truncating answers longer than `cap` bytes. */
function fakeUnit(
  faults = CLUSTER_FAULTS,
  opts: { cap?: number; silent?: boolean; dropFirst?: number } = {},
) {
  const sent: number[][] = [];
  let drops = opts.dropFirst ?? 0;
  const send = async (pdu: number[]): Promise<UdsAnswer> => {
    sent.push(pdu);
    if (opts.silent) return { kind: 'no-reply', adapter: 'UNABLE TO CONNECT' };
    if (drops > 0) {
      drops--;
      return { kind: 'no-reply', adapter: 'NO DATA' };
    }
    let bytes: number[];
    if (pdu[0] === 0x22)
      bytes =
        pdu[1] === 0xf1 && pdu[2] === 0x87
          ? [0x62, 0xf1, 0x87, ...Array.from('6JM920310', (c) => c.charCodeAt(0))]
          : [0x7f, 0x22, 0x31];
    else bytes = answerReadDtc(pdu, faults);
    if (bytes[0] === 0x7f) return { kind: 'nrc', code: bytes[2]! };
    if (opts.cap && bytes.length > opts.cap)
      return { kind: 'truncated', partial: bytes.slice(0, opts.cap), declared: bytes.length };
    return { kind: 'ok', bytes };
  };
  return { send, sent };
}

const UNIT = { unit: '17', label: 'instrument cluster', request: '714', response: '77E' };

describe('reading a unit', () => {
  it('a silent unit is not reachable and asked nothing after its part number', async () => {
    const { send, sent } = fakeUnit(CLUSTER_FAULTS, { silent: true });
    const r = await readUnitHealth(UNIT, send);
    expect(r.reachable).toBe(false);
    expect(sent.every((p) => p[0] === 0x22 && p[2] === 0x87)).toBe(true);
  });

  it('asks a dropped request again before it counts', async () => {
    const { send } = fakeUnit(BCM_FAULTS, { dropFirst: 1 });
    const r = await readUnitHealth(UNIT, send);
    expect(r.reachable).toBe(true);
    expect(r.identity.part).toEqual({ status: 'ok', value: '6JM920310' });
    expect(r.identity.software?.status).toBe('not supported');
  });

  it('reports a truncated list as such and splits it by status mask', async () => {
    // the live clone: first frame + 4 consecutive frames = 34 bytes
    const { send, sent } = fakeUnit(CLUSTER_FAULTS, { cap: 34 });
    const r = await readUnitHealth(UNIT, send);
    expect(r.faults.notes[0]).toBe(
      '19 02 2D truncated: got 34 of 35 bytes; asked again split by status mask',
    );
    expect(sent.filter((p) => p[0] === 0x19 && p[1] === 0x02).map((p) => p[2])).toEqual([
      0x2d, 0x08, 0x04, 0x01, 0x20,
    ]);
    // the four splits cover the whole fault mask and arrived whole: the fault list is complete
    expect(r.faults.status).toBe('ok');
    expect(r.faults.notes).toContain(
      'the split lists (08, 04, 01, 20) arrived whole: the fault list is complete',
    );
    // the 8 faults; the 50 / 10 / 40 entries are never asked for
    expect(r.faults.dtcs).toHaveLength(8);
    expect(r.faults.dtcs.every((d) => isFaultStatus(d.status))).toBe(true);
    expect(r.faults.count).toBe(11);
    expect(r.faults.faultCount).toBe(8);
    // every request it made is a health read
    expect(sent.every(isHealthRequest)).toBe(true);
    // snapshot and extended data for each DTC
    expect(r.faults.dtcs[0]?.extended?.records?.find((x) => x.record === 2)?.value).toBe(5);
  });

  it('asks the fault mask 2D, never FF, for the list', async () => {
    const { send, sent } = fakeUnit(BCM_FAULTS);
    const r = await readUnitHealth(UNIT, send);
    expect(sent.filter((p) => p[0] === 0x19 && p[1] === 0x02)).toEqual([[0x19, 0x02, 0x2d]]);
    expect(sent.filter((p) => p[0] === 0x19 && p[1] === 0x01).map((p) => p[2])).toEqual([0xff, 0x2d]);
    expect(r.faults).toMatchObject({ status: 'ok', listMask: '2D', count: 3, faultCount: 2 });
    // the 10-only entry is not a fault and not listed
    expect(r.faults.dtcs.map((d) => d.statusHex)).toEqual(['28', '24']);
    expect(r.faults.notes).toEqual([]);
  });

  it('a unit that ignores the mask: entries without a fault bit are kept but are not faults', async () => {
    const sent: number[][] = [];
    const { send: inner } = fakeUnit(CLUSTER_FAULTS);
    const send = async (pdu: number[]) => {
      sent.push(pdu);
      // answers every list request as if it were FF
      return inner(pdu[0] === 0x19 && pdu[1] === 0x02 ? [0x19, 0x02, 0xff] : pdu);
    };
    const r = await readUnitHealth(UNIT, send);
    expect(r.faults.dtcs).toHaveLength(11);
    expect(faultDtcs(r.faults)).toHaveLength(8);
    expect(r.faults.notes).toContain(
      '3 listed entries have no fault bit (unit ignored the mask): kept, not counted as faults',
    );
    // snapshot / extended data only for the faults
    const detailed = sent.filter((p) => p[0] === 0x19 && p[1] === 0x04).map((p) => p[4]);
    expect(detailed).toHaveLength(8);
    expect(r.faults.dtcs.filter((d) => !isFaultStatus(d.status)).every((d) => !d.snapshot)).toBe(true);
  });

  it('refuses before sending if the transport were handed something else', async () => {
    const sent: number[][] = [];
    const evil = async (pdu: number[]): Promise<UdsAnswer> => {
      sent.push(pdu);
      return { kind: 'ok', bytes: [0x54] };
    };
    const { guardedSend } = await import('./uds.ts');
    await expect(guardedSend(evil)([0x14, 0xff, 0xff, 0xff])).rejects.toThrow(HealthReadOnlyViolation);
    expect(sent).toHaveLength(0);
  });
});

/** The generic OBD-II half against the emulator with the synthetic faulty engine. */
async function obdFromEmulator() {
  const clock = new VirtualClock();
  const [, gearbox] = kushaqLikeSpecs();
  const emu = new Elm327Emulator({
    clock,
    ecus: [new StandardEcu(faultyEngineSpec()), new StandardEcu(gearbox!)],
  });
  const engine = new OBDCraftEngine({ clock });
  await runVirtual(clock, engine.connect(emu));
  const policy = engine.link!.policy;
  const release = policy.enterHealthReadOnly();
  const scan = await runVirtual(clock, engine.fullScan());
  release();
  return { section: obdSection(scan, engine.ecus), refused: policy.refused };
}

describe('OBD-II section', () => {
  it('reads codes, freeze frame, counters, readiness and misfire monitors under the lock, refusing nothing', async () => {
    const { section, refused } = await obdFromEmulator();
    expect(refused).toEqual([]);
    expect(section.mil).toEqual({ status: 'ok', value: true });
    expect(section.dtcs.stored.codes.map((c) => c.code)).toEqual(['P0301']);
    expect(section.dtcs.pending.codes.map((c) => c.code)).toEqual(['P0299']);
    expect(section.dtcs.permanent.codes.map((c) => c.code)).toEqual(['P0301']);
    expect(section.freezeFrames[0]).toMatchObject({ ecu: '7E8', dtc: 'P0301' });
    expect(section.freezeFrames[0]?.values.find((v) => v.name === 'Engine speed')?.value).toBe(1000);
    expect(section.counters.distanceSinceClearKm).toEqual({ status: 'ok', value: 1876 });
    expect(section.counters.warmupsSinceClear).toEqual({ status: 'ok', value: 87 });
    expect(section.counters.minutesSinceClear.status).toBe('not supported');
    expect(section.counters.odometerKm.status).toBe('not supported');
    expect(section.monitors.status).toBe('ok');
    const tests = section.tests.status === 'ok' ? section.tests.value : [];
    const cyl1 = tests.find((t) => t.mid === 'A2' && t.tid === '0B');
    expect(cyl1).toMatchObject({ value: 28, max: 20, passed: false, highlight: 'misfire cylinder 1' });
    expect(chooseOdometer(section, 27000)).toEqual({ km: 27000, source: '--odometer' });
    expect(chooseOdometer(section, undefined)).toEqual({ km: null, source: 'not recorded' });
  });

  it('puts nothing but reads on the wire: full scan, live polling and a clear attempt under the lock', async () => {
    const clock = new VirtualClock();
    const [, gearbox] = kushaqLikeSpecs();
    const emu = new Elm327Emulator({
      clock,
      ecus: [new StandardEcu(faultyEngineSpec()), new StandardEcu(gearbox!)],
    });
    const tx: string[] = [];
    const engine = new OBDCraftEngine({
      clock,
      onWire: (e) => {
        if (e.dir === 'tx') tx.push(e.text.replace(/\s+/g, '').toUpperCase());
      },
    });
    await runVirtual(clock, engine.connect(emu));
    const policy = engine.link!.policy;
    const earlyToken = policy.issueClearToken();
    const release = policy.enterHealthReadOnly();
    const from = tx.length;
    await runVirtual(clock, engine.fullScan());
    await engine.startLive({ pids: [0x0c, 0x0d, 0x49, 0x0b, 0x0e, 0x70, 0x6d] });
    await runVirtual(clock, clock.sleep(5000));
    await runVirtual(clock, engine.stopLive());
    // No clear token is issued while the lock holds, and one issued before it is not honoured: 04 never leaves.
    expect(() => policy.issueClearToken()).toThrow(/health snapshot/);
    const clear = await runVirtual(
      clock,
      engine.ctx!.runner.execute({
        service: 0x04,
        params: [],
        purpose: 'clear',
        clearToken: earlyToken,
        maxAttempts: 1,
      }),
    );
    expect(clear.status).toBe('refused');
    release();
    expect(policy.refused.map((r) => r.command)).toEqual(['04']);
    const sent = tx.slice(from).filter((c) => !c.startsWith('AT') && !c.startsWith('ST'));
    expect(sent.length).toBeGreaterThan(20);
    // Strip a trailing ELM response-count digit before reading the service byte.
    for (const c of sent) {
      const body = c.length % 2 === 1 ? c.slice(0, -1) : c;
      expect(isHealthRequest(hex(body)), c).toBe(true);
    }
    expect(sent.some((c) => c === '04' || c.startsWith('14'))).toBe(false);
    expect(sent.some((c) => c.startsWith('08') && c !== '0800' && c !== '08001')).toBe(false);
  });

  it('says why when no ECU answered, instead of empty values', () => {
    const section = obdSection(null, []);
    expect(section.answered).toBe(false);
    expect(section.mil.status).toBe('not read');
  });
});

async function snapshot(
  label: string,
  edit: (s: HealthSnapshot) => void = () => {},
): Promise<HealthSnapshot> {
  const { section } = await obdFromEmulator();
  const cluster = await readUnitHealth(UNIT, fakeUnit(CLUSTER_FAULTS).send);
  const bcm = await readUnitHealth(
    { unit: '09', label: 'central electrics', request: '70E', response: '778' },
    fakeUnit(BCM_FAULTS).send,
  );
  const s: HealthSnapshot = {
    schema: HEALTH_SCHEMA,
    label,
    takenAt: '2026-11-08T10:00:00.000Z',
    finishedAt: '2026-11-08T10:05:00.000Z',
    odometer: chooseOdometer(section, 27000),
    car: { vin: 'TMBDEMO0OBDCRAFT1', adapter: 'ELM327 v2.1', voltage: '12.6V', synthetic: true },
    obd: section,
    units: [bcm, cluster],
    notReachable: [],
    readOnly: { locked: true, refused: [] },
    notes: [],
  };
  edit(s);
  return s;
}

describe('compare', () => {
  it('tells a code clear from a repair', async () => {
    const before = await snapshot('baseline');
    const after = await snapshot('after', (s) => {
      s.obd.dtcs.stored.codes = [];
      s.obd.dtcs.pending.codes = [];
      if (s.obd.counters.distanceSinceClearKm.status === 'ok') s.obd.counters.distanceSinceClearKm.value = 12;
      s.units[0]!.faults.dtcs = [];
      const d = s.units[1]!.faults.dtcs[0]!;
      d.status |= 0x10;
      d.extended!.records!.find((r) => r.record === 2)!.value = 1;
      s.units[1]!.identity.software = { status: 'ok', value: '0204' };
    });
    after.units[1]!.faults.dtcs = [after.units[1]!.faults.dtcs[0]!];
    before.units[1]!.identity.software = { status: 'ok', value: '0203' };
    const c = compareSnapshots(before, after);
    expect(c.sameCar).toBe(true);
    expect(c.gone.map((g) => g.code)).toContain('P0301');
    expect(c.permanentStill.map((p) => p.code)).toEqual(['P0301']);
    expect(
      c.clearEvidence.some((e) =>
        e.startsWith('PID 31 distance since codes cleared went down from 1876 km to 12 km'),
      ),
    ).toBe(true);
    expect(c.clearEvidence.some((e) => /extended record 02 .*went down from 5 to 1/.test(e))).toBe(true);
    expect(c.clearEvidence.some((e) => e.includes('test not completed since the last clear'))).toBe(true);
    expect(c.clearedNotProven.length).toBe(c.gone.length);
    expect(c.softwareChanges).toEqual([
      'unit 17 instrument cluster software changed: 0203 → 0204 (software update)',
    ]);
    expect(c.verdict).toMatch(/cleared, fix not proven/);
    expect(comparisonMarkdown(c)).toContain('## Cleared but not proven fixed');
  });

  it('a code whose source was not re-read is not "gone"', async () => {
    const before = await snapshot('baseline');
    const after = await snapshot('after', (s) => {
      s.units[0]!.reachable = false;
      s.units[0]!.faults = { status: 'no answer', count: null, dtcs: [], notes: [], raw: [] };
      s.units[1]!.faults.status = 'partial';
      s.units[1]!.faults.dtcs = s.units[1]!.faults.dtcs.slice(0, 2);
      s.obd.dtcs.pending = { status: 'error', codes: [] };
    });
    const c = compareSnapshots(before, after);
    expect(c.gone).toEqual([]);
    expect(c.notReread.length).toBeGreaterThan(0);
    expect(c.notReread.map((f) => f.status)).toEqual(
      expect.arrayContaining([
        'not re-read: unit not reachable',
        'not re-read: fault list partial',
        'not re-read: OBD pending list error',
      ]),
    );
    expect(c.verdict).not.toMatch(/went away on their own/);
  });

  it('PID 31 grown less than the odometer is a clear; codes still there are cleared and back', async () => {
    const before = await snapshot('baseline');
    const after = await snapshot('after', (s) => {
      // Cleared at the dealer, then 2000 km driven: PID 31 is above the old 1876 km but far below 1876 + 2500.
      if (s.obd.counters.distanceSinceClearKm.status === 'ok')
        s.obd.counters.distanceSinceClearKm.value = 2000;
      s.odometer = { km: 29500, source: '--odometer' };
      // An unlearning-counter style change on its own is no clear evidence.
      const r3 = s.units[1]!.faults.dtcs[0]!.extended?.records?.find((r) => r.record === 3);
      if (r3?.value !== undefined) r3.value = Math.max(0, r3.value - 1);
    });
    const c = compareSnapshots(before, after);
    expect(c.clearEvidence.some((e) => /PID 31 .* grew by 124 km .* odometer grew by 2500 km/.test(e))).toBe(
      true,
    );
    expect(c.clearEvidence.some((e) => /extended record 03/.test(e))).toBe(false);
    expect(c.clearedAndBack.map((f) => f.code)).toEqual(expect.arrayContaining(['P0301', 'P0299']));
    expect(c.clearedAndBack.every((f) => f.source.startsWith('OBD') && !f.source.includes('permanent'))).toBe(
      true,
    );
    expect(c.verdict).toMatch(/cleared and came back/);
  });

  it('nothing changed: nothing fixed', async () => {
    const c = compareSnapshots(await snapshot('a'), await snapshot('b'));
    expect(c.gone).toEqual([]);
    expect(c.clearEvidence).toEqual([]);
    expect(c.verdict).toMatch(/Nothing was fixed/);
  });
});

/** A synthetic log: idle, then a full-throttle pull with slow boost and timing pulled back, a mark, lean trims. */
function syntheticLog(): string {
  const columns = columnsFor([0x0c, 0x0d, 0x49, 0x0b, 0x0e, 0x6d, 0x07, 0x05]);
  const lines = [
    csvMeta('scenario', 'D'),
    csvMeta('started', '2026-11-08T10:00:00.000Z'),
    csvMeta('baro_kpa', '98'),
    csvHeader(columns),
  ];
  for (let t = 0; t <= 60_000; t += 100) {
    const wot = t >= 20_000 && t < 28_000;
    const into = Math.max(0, t - 20_000);
    const row: LogRow = {
      t,
      time: new Date(Date.parse('2026-11-08T10:00:00.000Z') + t).toISOString(),
      type: 'sample',
      values: {
        rpm: wot ? 1500 + into / 2 : 800,
        speed: wot ? 20 + into / 200 : 20,
        pedal_d: wot ? 95 : 15,
        map: wot ? Math.min(180, 40 + into / 25) : 35,
        // a held retard at 3500-3700 rpm (into 4000-4400 ms), else the base map
        timing_advance: wot ? (into >= 4000 && into < 4500 ? -9 : -2) : 12,
        fuel_pressure_ctrl_act_a: wot ? 4000 : 35000,
        ltft_b1: 14,
        coolant_temp: 20 + t / 1000,
      },
    };
    lines.push(csvRow(columns, row));
  }
  lines.push(
    csvRow(columns, {
      t: 25_000,
      time: '2026-11-08T10:00:25.000Z',
      type: 'MARK',
      note: 'clatter, light "throttle"',
      values: {},
    }),
  );
  return `${lines.join('\n')}\n`;
}

describe('live log', () => {
  it('parses PID lists and logs only supported PIDs, with the rail-pressure fallback for --fast', () => {
    expect(parsePidList('0C, 0d,49')).toEqual([0x0c, 0x0d, 0x49]);
    expect(() => parsePidList('20')).toThrow(/support bitmap/);
    const supported = new Set([0x0c, 0x0d, 0x49, 0x11, 0x0b, 0x0e, 0x6d, 0x70]);
    expect(selectPids([0x0c, 0x0d, 0x49, 0x11, 0x0b, 0x0e, 0x23, 0x70], supported, true)).toEqual({
      use: [0x0c, 0x0d, 0x49, 0x11, 0x0b, 0x0e, 0x70, 0x6d],
      unsupported: [0x23],
    });
  });

  it('round-trips the CSV, quoted notes included', () => {
    const file = parseLogCsv(syntheticLog());
    expect(file.scenario).toBe('D');
    expect(file.meta.baro_kpa).toBe('98');
    expect(file.columns.find((c) => c.key === 'rpm')).toEqual({ pid: '0C', key: 'rpm', unit: 'rpm' });
    expect(file.rows.find((r) => r.type === 'MARK')?.note).toBe('clatter, light "throttle"');
  });

  it('summarises full throttle, trims, warm-up and marks', () => {
    const s = summarizeLog(parseLogCsv(syntheticLog()));
    expect(s.throttleEvents).toHaveLength(1);
    const e = s.throttleEvents[0]!;
    expect(e.startMs).toBe(20_000);
    expect(e.msToPeakMap).toBe(3500);
    expect(e.boostKpa).toBe(82);
    expect(e.timingMinDeg).toBe(-9);
    expect(e.fullBoostMs).toEqual({ lo: 3200, hi: 3400 });
    expect(e.timingRetard?.samples.map((x) => x.deg)).toEqual([-9, -9, -9, -9, -9]);
    expect(e.timingRetard?.samples[0]?.refDeg).toBe(-2);
    expect(s.fullLoadTiming.map((b) => b.rpmFrom)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(e.railMinKpa).toBe(4000);
    expect(e.rpmRise).toBeGreaterThan(3000);
    expect(s.trimRuns[0]).toMatchObject({ key: 'ltft_b1', meanPct: 14 });
    expect(s.warmup).toMatchObject({ coldStart: true, startC: 20 });
    expect(s.marks[0]).toMatchObject({ note: 'clatter, light "throttle"', rpm: 4000 });
  });

  it('takes 90 % of the highest pedal when the pedal never reads 90 %', () => {
    const text = syntheticLog().replace(/,95,/g, ',82,');
    const s = summarizeLog(parseLogCsv(text));
    expect(s.fullThrottleThresholdPct).toBeCloseTo(82 * THRESHOLDS.fullThrottleRelative, 1);
    expect(s.throttleEvents).toHaveLength(1);
  });
});

/**
 * A log built from per-PID samples, as the live link records them (one PID per row, ~0.3-1 s apart).
 * `wot` is [from, to] ms of full throttle; every series is a function of t sampled at its own times.
 */
function sampledLog(spec: {
  ms: number;
  every?: Partial<Record<string, number>>;
  offset?: Partial<Record<string, number>>;
  values: Record<string, (t: number) => number>;
  meta?: Record<string, string>;
}): LogFile {
  const rows: LogRow[] = [];
  for (const [key, f] of Object.entries(spec.values)) {
    const step = spec.every?.[key] ?? 600;
    for (let t = spec.offset?.[key] ?? 0; t <= spec.ms; t += step)
      rows.push({
        t,
        time: new Date(Date.parse('2026-11-09T14:50:00.000Z') + t).toISOString(),
        type: 'sample',
        values: { [key]: f(t) },
      });
  }
  rows.sort((a, b) => a.t - b.t);
  return { scenario: 'D', meta: { baro_kpa: '99', ...spec.meta }, columns: [], rows };
}

describe('full-throttle heuristics from the first car session (2026-11-09)', () => {
  // A pull from 20 s to 26 s: rpm climbs 2000 → 3700, upshift at 23.4 s (rpm falls to 2800), pedal lifted at 26 s.
  const rpmOf = (t: number) =>
    t < 20_000 ? 1500 : t < 23_400 ? 2000 + (t - 20_000) / 2 : t < 26_000 ? 2800 + (t - 23_400) / 2 : 3000;
  const pull = (timing: (t: number) => number, map?: (t: number) => number) =>
    sampledLog({
      ms: 30_000,
      every: { rpm: 300, pedal_d: 300, timing_advance: 300, map: 300 },
      offset: { pedal_d: 100, timing_advance: 200, map: 50 },
      values: {
        rpm: rpmOf,
        pedal_d: (t) => (t >= 20_000 && t < 26_000 ? 87.8 : 14.5),
        map: map ?? ((t) => (t >= 20_000 && t < 26_000 ? Math.min(205, 100 + (t - 20_000) / 10) : 30)),
        timing_advance: timing,
        coolant_temp: () => 88,
      },
    });
  const base = (t: number) => (rpmOf(t) < 3300 ? 1 : 4);

  it('a shift torque cut and a pedal-lift reading are not knock retard: reported as normal with the numbers', () => {
    // -7° right at the upshift (23.3-23.9 s) and on the last sample before the pedal-lift sample
    const s = summarizeLog(
      pull((t) => ((t >= 23_300 && t <= 23_900) || (t >= 25_950 && t <= 26_100) ? -7 : base(t))),
    );
    const e = s.throttleEvents[0]!;
    expect(e.timingMinDeg).toBe(-7);
    expect(e.timingRetard).toBeNull();
    expect(e.timingExcluded.map((x) => x.why)).toEqual(['upshift', 'upshift', 'upshift', 'pedal lift']);
    const f = logFindings(s, 'pull', '2026-11-09T14:50:00.000Z');
    expect(f.some((x) => x.title === 'Ignition timing pulled back at full throttle')).toBe(false);
    const normal = f.find((x) => x.title.startsWith('Full-throttle timing dips are shift'))!;
    expect(normal.section).toBe('normal');
    expect(normal.evidence.join(' ')).toMatch(/-7\.0° at .* \(upshift, \d+ rpm\)/);
    expect(normal.evidence.join(' ')).toMatch(/\(pedal lift, \d+ rpm\)/);
  });

  it('a single low timing sample with the pedal held is not flagged; two in a row, well below the median, are', () => {
    const one = summarizeLog(pull((t) => (t === 21_200 ? -6 : base(t))));
    expect(one.throttleEvents[0]!.timingRetard).toBeNull();
    const two = summarizeLog(pull((t) => (t === 21_200 || t === 21_500 ? -6 : base(t))));
    const r = two.throttleEvents[0]!.timingRetard!;
    expect(r.samples.map((x) => [x.t, x.deg, x.refDeg])).toEqual([
      [21_200, -6, 1],
      [21_500, -6, 1],
    ]);
    const f = logFindings(two, 'pull', undefined);
    const retard = f.filter((x) => x.title === 'Ignition timing pulled back at full throttle');
    expect(retard).toHaveLength(1);
    expect(retard[0]!.section).toBe('suspicious');
    // Low but not 4° below the same log's full-load timing at that rpm: the base map, not retard.
    const shallow = summarizeLog(pull((t) => (t >= 21_000 && t <= 21_600 ? -2 : base(t))));
    expect(shallow.throttleEvents[0]!.timingRetard).toBeNull();
  });

  it('slow boost uses the lower bound of the sampled bracket', () => {
    // MAP read only every 3.5 s: last short sample 0.05 s after pedal down, full boost seen at 3.55 s. Bracket
    // 0.05-3.65 s: the lower bound is under 3 s, so nothing is flagged although the sample times say 3.5 s.
    const coarse = sampledLog({
      ms: 30_000,
      every: { map: 3500, pedal_d: 300 },
      offset: { map: 20_050 - 3500 * 5, pedal_d: 100 },
      values: {
        rpm: rpmOf,
        pedal_d: (t) => (t >= 20_000 && t < 27_000 ? 87.8 : 14.5),
        map: (t) => (t >= 23_000 && t < 27_000 ? 205 : t >= 20_000 && t < 27_000 ? 110 : 30),
      },
    });
    const e = summarizeLog(coarse).throttleEvents[0]!;
    expect(e.fullBoostMs!.lo).toBeLessThan(THRESHOLDS.slowBoostMs);
    expect(e.fullBoostMs!.hi).toBeGreaterThan(THRESHOLDS.slowBoostMs);
    expect(
      logFindings(summarizeLog(coarse), 'pull', undefined).some((x) => x.title.startsWith('Slow boost')),
    ).toBe(false);
    // Dense samples still short of full boost after 3 s: flagged, one finding for both pulls of the log.
    const slowMap = (t: number) => {
      const into = t >= 40_000 ? t - 40_000 : t - 20_000;
      return into >= 0 && into < 6_000 ? (into < 3_600 ? 120 : 205) : 30;
    };
    const twoPulls = sampledLog({
      ms: 50_000,
      every: { map: 300, pedal_d: 300 },
      offset: { pedal_d: 100 },
      values: {
        rpm: (t) => (t % 20_000 < 6_000 ? 2000 + (t % 20_000) / 2 : 1500),
        pedal_d: (t) => (t >= 20_000 && t % 20_000 < 6_000 ? 87.8 : 14.5),
        map: slowMap,
      },
    });
    const f = logFindings(summarizeLog(twoPulls), 'pull', undefined).filter((x) =>
      x.title.startsWith('Slow boost'),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toHaveLength(2);
    expect(f[0]!.evidence[0]).toMatch(/at least 3\.\d s: over 3 s/);
  });

  it('flags timing far back at low rpm under load (the clatter clue), not when cold or at higher rpm', () => {
    // log A t≈212-221 s: creeping in D, pedal released, ~950 rpm, MAP 85-87 kPa, load 33 %, timing -16.5°
    const creep = (coolant: number, rpm: number) =>
      sampledLog({
        ms: 230_000,
        offset: { timing_advance: 200, map: 100, engine_load: 300, speed: 400 },
        values: {
          rpm: () => rpm,
          speed: () => 4,
          engine_load: (t) => (t >= 212_000 && t <= 221_000 ? 33 : 20),
          map: (t) => (t >= 212_000 && t <= 221_000 ? 86 : 40),
          timing_advance: (t) => (t >= 212_000 && t <= 221_000 ? -16.5 : 8),
          coolant_temp: () => coolant,
        },
      });
    const s = summarizeLog(creep(85, 950));
    expect(s.lowRpmRetard).toHaveLength(1);
    expect(s.lowRpmRetard[0]).toMatchObject({ minDeg: -16.5 });
    expect(s.lowRpmRetard[0]!.startMs).toBeGreaterThanOrEqual(212_000);
    expect(s.lowRpmRetard[0]!.endMs).toBeLessThanOrEqual(221_000);
    const f = logFindings(s, 'cold start', '2026-11-09T14:38:28.147Z');
    const low = f.find((x) => x.title === 'Ignition timing pulled far back at low rpm under load')!;
    expect(low.section).toBe('suspicious');
    expect(low.relates).toEqual(['clatter']);
    expect(low.evidence[0]).toMatch(
      /^scenario D \(cold start\), 2026-11-09 14:42:\d\d UTC to 14:4\d:\d\d: -16\.5° at 950 rpm, load 33 %, MAP \d+ kPa/,
    );
    expect(low.jobCard).toMatch(/knock control/);
    expect(summarizeLog(creep(30, 950)).lowRpmRetard).toEqual([]);
    // Right after a start the log saw (rpm 0 → running): catalyst heating, not judged.
    const started = creep(85, 950);
    started.rows = started.rows.map((r) =>
      r.values.rpm !== undefined ? { ...r, values: { rpm: r.t < 200_000 ? 0 : 950 } } : r,
    );
    expect(summarizeLog(started).lowRpmRetard).toEqual([]);
    expect(summarizeLog(creep(85, 1600)).lowRpmRetard).toEqual([]);
    // The same finding from two logs is one finding with both logs' evidence (the rule line once).
    const merged = mergeFindings([...f, ...logFindings(s, 'city', undefined)]).filter(
      (x) => x.title === low.title,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence.filter((e) => e.startsWith('rule:'))).toHaveLength(1);
    expect(merged[0]!.evidence.filter((e) => e.startsWith('scenario D'))).toHaveLength(2);
  });
});

describe('report', () => {
  it('sorts findings into confirmed / suspicious / normal with evidence and job-card lines', async () => {
    const s = await snapshot('baseline');
    const log = summarizeLog(parseLogCsv(syntheticLog()));
    const findings = [
      ...healthFindings(s),
      ...logFindings(log, 'full-throttle pull in D', '2026-11-08T10:00:00.000Z'),
    ];
    const titles = (section: string) => findings.filter((f) => f.section === section).map((f) => f.title);
    expect(titles('confirmed')).toContain('P0301 stored in the engine ECU (misfire)');
    expect(titles('suspicious')).toEqual(
      expect.arrayContaining([
        'P0299 pending in the engine ECU (turbo boost)',
        'Slow boost build-up at full throttle',
        'Ignition timing pulled back at full throttle',
        'Low fuel rail pressure at full throttle',
      ]),
    );
    const slow = findings.find((f) => f.title === 'Slow boost build-up at full throttle')!;
    expect(slow.relates).toEqual(['power']);
    expect(slow.evidence[0]).toContain('2026-11-08 10:00:20 UTC');
    expect(slow.evidence[0]).toContain('reached 3.2-3.4 s after pedal down');
    expect(slow.jobCard).toMatch(/at least 3\.2 s to full boost/);
    const retard = findings.find((f) => f.title === 'Ignition timing pulled back at full throttle')!;
    expect(retard.evidence[0]).toMatch(/pedal held, no shift, \d+ timing samples in a row -9\.0°/);
    const md = reportMarkdown({
      car: 'Kushaq',
      vin: s.car.vin,
      odometer: '27000 km',
      takenAt: s.takenAt,
      sources: ['a.json'],
      findings,
      synthetic: true,
    });
    expect(md.indexOf('## Confirmed faults')).toBeLessThan(md.indexOf('## Suspicious readings'));
    expect(md).toContain('## For the job card');
    const html = reportHtml({
      car: 'Kushaq <script>',
      vin: null,
      odometer: 'n/a',
      takenAt: s.takenAt,
      sources: [],
      findings,
      synthetic: false,
    });
    expect(html).toContain('Kushaq &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders the snapshot Markdown with not-supported values said so', async () => {
    const md = healthMarkdown(await snapshot('baseline'));
    expect(md).toContain('Time since codes cleared (PID 4E): not supported');
    expect(md).toContain(
      'fault memory: ok, listed with mask 2D, unit counts 11 entries with any status bit, 8 fault(s) (19 01 2D)',
    );
    expect(md).toContain('(unverified)');
  });
});

describe('fault mask and classification', () => {
  it('2D is testFailed | pending | confirmed | failed since the last clear, and the splits cover it', () => {
    expect(FAULT_STATUS_MASK).toBe(0x01 | 0x04 | 0x08 | 0x20);
    expect(SPLIT_MASKS.reduce((m, x) => m | x.mask, 0)).toBe(FAULT_STATUS_MASK);
  });

  it('classifies status bytes: confirmed, pending, failing now, failed since clear; 10 / 40 / 02 / 80 are not faults', () => {
    const table: [number, ReturnType<typeof faultClass>][] = [
      [0x08, 'confirmed'],
      [0x28, 'confirmed'],
      [0x2f, 'confirmed'],
      [0x0d, 'confirmed'],
      [0x04, 'pending'],
      [0x24, 'pending'],
      [0x05, 'pending'],
      [0x01, 'failing now'],
      [0x03, 'failing now'],
      [0x20, 'failed since the last clear'],
      [0x60, 'failed since the last clear'],
      [0x10, null],
      [0x40, null],
      [0x50, null],
      [0x02, null],
      [0x80, null],
      [0xd2, null],
      [0x00, null],
    ];
    for (const [status, cls] of table) {
      expect(faultClass(status), status.toString(16)).toBe(cls);
      expect(isFaultStatus(status), status.toString(16)).toBe(cls !== null);
    }
  });
});

describe('re-analysing a snapshot taken with 19 02 FF', () => {
  /** As the Kushaq answered FF: a few faults among many "test not completed" entries; no listMask recorded. */
  async function oldSnapshot(): Promise<HealthSnapshot> {
    const s = await snapshot('old');
    const steering = {
      unit: '44',
      label: 'power steering',
      request: '712',
      response: '77C',
      reachable: true,
      identity: {},
      faults: {
        status: 'ok' as const,
        count: 144,
        dtcs: Array.from({ length: 144 }, (_, i) => udsDtcOf([0xc4, i, 0x00, 0x10])),
        notes: [],
        raw: [],
      },
      issues: [],
    };
    const engine = {
      ...steering,
      unit: '01',
      label: 'engine',
      request: '7E0',
      response: '7E8',
      faults: {
        status: 'ok' as const,
        count: 6,
        dtcs: [
          ...[0x40, 0x40, 0x50, 0x50].map((st, i) => udsDtcOf([0x03, i, 0x00, st])),
          udsDtcOf([0x03, 0x01, 0x10, 0x28]),
        ],
        notes: [],
        raw: [],
      },
    };
    for (const u of s.units) {
      delete u.faults.listMask;
      delete u.faults.faultCount;
    }
    s.units.push(steering, engine);
    return s;
  }

  it('counts and reports only entries with a fault bit', async () => {
    const s = await oldSnapshot();
    const summary = healthSummary(s).join('\n');
    expect(summary).toMatch(/UDS faults 11 \(plus 148 listed entries without a fault bit, not faults\)/);
    expect(summary).not.toMatch(/unit 44 power steering/);
    expect(summary).toMatch(/unit 01 engine: ok, VW 196880 \(0x030110\) confirmed \(28\)/);
    expect(summary).not.toMatch(/P0301-10/);
    const faults = allFaults(s).filter((f) => f.source.startsWith('unit'));
    expect(faults.map((f) => f.code)).toContain('VW 196880 (0x030110)');
    expect(faults.every((f) => f.detail.endsWith(UDS_DTC_MEANING))).toBe(true);
    expect(faults.some((f) => f.source.includes('power steering'))).toBe(false);
    const findings = healthFindings(s);
    expect(findings.filter((f) => f.title.includes('power steering') && f.section !== 'normal')).toEqual([]);
    const engineDtc = findings.find((f) => f.title.startsWith('VW 196880 (0x030110) in engine'))!;
    expect(engineDtc.section).toBe('confirmed');
    expect(engineDtc.jobCard).not.toMatch(/P0301|misfire/);
    expect(findings.find((f) => f.title.startsWith('Not faults: 148'))?.section).toBe('normal');
    expect(findings.find((f) => f.title.startsWith('No fault codes in'))?.evidence[0]).toContain(
      'power steering',
    );
    const md = healthMarkdown(s);
    expect(md).toContain('listed with mask FF (every status bit; filtered to faults here)');
    expect(md).toContain('also listed: 144 entries without a fault bit (not faults; status 10 ×144)');
    expect(md).toContain('also listed: 4 entries without a fault bit (not faults; status 40 ×2, 50 ×2)');
    expect(md).not.toMatch(/\*\*U0400\*\*/);
  });

  it('compare ignores entries without a fault bit, old snapshot against new', async () => {
    const before = await oldSnapshot();
    const after = await snapshot('new');
    // after: steering and engine re-read with the fault mask, the engine fault gone and nothing else listed
    const steering = {
      ...before.units[2]!,
      faults: {
        status: 'ok' as const,
        count: 144,
        faultCount: 0,
        listMask: '2D',
        dtcs: [],
        notes: [],
        raw: [],
      },
    };
    const engine = { ...before.units[3]!, faults: { ...steering.faults, count: 6 } };
    after.units.push(steering, engine);
    const c = compareSnapshots(before, after);
    expect(c.gone.map((g) => `${g.source} ${g.code}`)).toEqual(['unit 01 engine VW 196880 (0x030110)']);
    expect(c.gone.concat(c.added, c.still).some((f) => f.source.includes('power steering'))).toBe(false);
    expect(c.still.find((f) => f.code === 'VW 12648448 (0xC10000)')?.status).toBe('28 confirmed');
  });
});
