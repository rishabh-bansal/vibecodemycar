/**
 * A synthetic car with faults, for rehearsing the health snapshot (`live health`, `live log`, `live compare`,
 * `live report`) on the fake bridge (emulator and clone simulator) and in tests. Every code, count and value here is
 * invented: nothing came from a real vehicle.
 *
 *  - engine (7E8): MIL on with one confirmed code, P0301 stored and permanent with a freeze frame, P0299 pending; PID
 *    21 / 30 / 31 counters; mode 06 misfire monitors A2..A4 with cylinder 1 outside its limit
 *  - BCM (70E): two UDS faults, each with a snapshot (19 04) and extended data (19 06), plus one entry whose only bit
 *    is 10 "test not completed since the last clear" (as VW units list them under mask FF: not a fault)
 *  - cluster (714): a long UDS fault list (eight faults, 35 bytes under the fault mask 2D): longer than the four
 *    consecutive frames the live clone forwards, so the simulator truncates it and the snapshot has to split it by
 *    status mask; plus three entries without a fault bit (50, 10, 40) that only mask FF lists
 */
import { type EcuModel, kushaqLikeSpecs, StandardEcu, type StandardEcuSpec } from '@obdcraft/obd-core';

const bytes = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .map((x) => Number.parseInt(x, 16));
const fixed = (s: string) => {
  const b = bytes(s);
  return () => b;
};

/** The engine ECU's fault-related answers on top of the Kushaq-like engine (see the file comment). */
export function faultyEngineSpec(base: Partial<StandardEcuSpec> = {}): StandardEcuSpec {
  const [engine] = kushaqLikeSpecs();
  return {
    ...engine!,
    ...base,
    pids: {
      ...engine!.pids,
      ...(base.pids ?? {}),
      // MIL on, one confirmed code; misfire / fuel / component monitors supported and complete
      1: fixed('81 07 E1 00'),
      33: fixed('00 2A'),
      48: fixed('57'),
      49: fixed('07 54'),
    },
    dtcs: { stored: ['P0301'], pending: ['P0299'], permanent: ['P0301'] },
    freeze: {
      dtc: 'P0301',
      values: { 4: bytes('B3'), 5: bytes('7B'), 11: bytes('8C'), 12: bytes('0F A0'), 13: bytes('2D') },
    },
    mode06: {
      ...engine!.mode06,
      // cylinder 1: 28 misfires averaged over recent cycles, limit 20 (outside); cylinders 2 and 3 low
      162: bytes('A2 0B 24 00 1C 00 00 00 14 A2 0C 24 00 0B 00 00 FF FF'),
      163: bytes('A3 0B 24 00 03 00 00 00 14 A3 0C 24 00 01 00 00 FF FF'),
      164: bytes('A4 0B 24 00 02 00 00 00 14 A4 0C 24 00 00 00 00 FF FF'),
    },
  };
}

/**
 * Wraps an engine ECU model so that its fault answers (01 01/21/30/31, 02, 03, 07, 0A, 06) come from
 * {@link faultyEngineSpec}; everything else (live data, identity) stays the wrapped model's.
 */
export function withEngineFaults(ecu: EcuModel): EcuModel {
  const faulty = new StandardEcu(faultyEngineSpec());
  const FAULT_PIDS = new Set([0x01, 0x21, 0x30, 0x31]);
  return {
    id: ecu.id,
    requestId: ecu.requestId,
    pad: ecu.pad,
    latencyMs: ecu.latencyMs,
    handle(req, t, physical) {
      const [svc, pid] = req;
      const ours =
        svc === 0x02 ||
        svc === 0x03 ||
        svc === 0x07 ||
        svc === 0x0a ||
        svc === 0x06 ||
        (svc === 0x01 && req.length === 2 && FAULT_PIDS.has(pid ?? -1));
      return ours ? faulty.handle(req, t, physical) : ecu.handle(req, t, physical);
    },
  };
}

/** One UDS DTC a module holds: 3 DTC bytes, the status byte, and its 19 04 / 19 06 record bytes (after the status). */
export interface UdsFault {
  dtc: readonly [number, number, number];
  status: number;
  snapshot?: readonly number[];
  extended?: readonly number[];
}

/** Snapshot record 01: VW mileage 2002 (27000 km), engine speed F40C, vehicle speed F40D. */
const SNAPSHOT = bytes('01 03 20 02 00 69 78 F4 0C 0B B8 F4 0D 00');
/** Extended data: priority 2, frequency counter 5, unlearning counter 254 (VW layout, one byte each). */
const EXTENDED = bytes('01 02 02 05 03 FE');

export const BCM_FAULTS: readonly UdsFault[] = [
  // U0100-00: lost communication with the engine ECU, confirmed, not failing now
  { dtc: [0xc1, 0x00, 0x00], status: 0x28, snapshot: SNAPSHOT, extended: EXTENDED },
  // a manufacturer-specific body code, pending
  { dtc: [0x9a, 0x13, 0x11], status: 0x24, snapshot: SNAPSHOT, extended: bytes('01 03 02 01 03 FF') },
  // test not completed since the last clear: not a fault
  { dtc: [0x9a, 0x20, 0x00], status: 0x10 },
];

/**
 * Eight faults: 3 + 8 × 4 = 35 bytes under mask 2D, five consecutive frames. Split by mask 08 / 04 / 01 / 20 each part
 * fits. Three more entries have no fault bit (only mask FF lists them: 3 + 11 × 4 = 47 bytes).
 */
export const CLUSTER_FAULTS: readonly UdsFault[] = [
  { dtc: [0xd1, 0x55, 0x00], status: 0x28, snapshot: SNAPSHOT, extended: EXTENDED },
  { dtc: [0xd1, 0x56, 0x00], status: 0x28 },
  { dtc: [0xc1, 0x21, 0x00], status: 0x28 },
  { dtc: [0xc1, 0x40, 0x00], status: 0x24 },
  { dtc: [0xc1, 0x55, 0x00], status: 0x24 },
  { dtc: [0xb1, 0x23, 0x13], status: 0x24 },
  { dtc: [0x95, 0x01, 0x1c], status: 0x03 },
  { dtc: [0x95, 0x02, 0x1c], status: 0x03 },
  // no fault bit (only 10 / 40 "test not completed"): mask 2D never lists them
  { dtc: [0x95, 0x03, 0x1c], status: 0x50 },
  { dtc: [0x95, 0x04, 0x1c], status: 0x10 },
  { dtc: [0x95, 0x05, 0x1c], status: 0x40 },
];

/** The status availability mask the synthetic modules report. */
const AVAILABILITY = 0xff;

/**
 * A ReadDTCInformation (19) answer from a module's fault list: 01 count by mask, 02 list by mask, 03 snapshot ids,
 * 04 snapshot, 06 extended data, 0A every DTC. Anything else is refused (7F 19 12).
 */
export function answerReadDtc(req: readonly number[], faults: readonly UdsFault[]): number[] {
  const sub = req[1];
  const match = (mask: number) => faults.filter((f) => f.status & mask);
  const find = () => faults.find((f) => f.dtc[0] === req[2] && f.dtc[1] === req[3] && f.dtc[2] === req[4]);
  switch (sub) {
    case 0x01: {
      if (req.length !== 3) return [0x7f, 0x19, 0x13];
      const n = match(req[2]!).length;
      return [0x59, 0x01, AVAILABILITY, 0x01, n >> 8, n & 0xff];
    }
    case 0x02:
      if (req.length !== 3) return [0x7f, 0x19, 0x13];
      return [0x59, 0x02, AVAILABILITY, ...match(req[2]!).flatMap((f) => [...f.dtc, f.status])];
    case 0x03:
      return [0x59, 0x03, ...faults.filter((f) => f.snapshot).flatMap((f) => [...f.dtc, 0x01])];
    case 0x04:
    case 0x06: {
      if (req.length !== 6) return [0x7f, 0x19, 0x13];
      const f = find();
      if (!f) return [0x7f, 0x19, 0x31];
      const data = sub === 0x04 ? f.snapshot : f.extended;
      return [0x59, sub, ...f.dtc, f.status, ...(data ?? [])];
    }
    case 0x0a:
      return [0x59, 0x0a, AVAILABILITY, ...faults.flatMap((f) => [...f.dtc, f.status])];
    default:
      return [0x7f, 0x19, 0x12];
  }
}
