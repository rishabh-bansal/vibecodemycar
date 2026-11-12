import { StandardEcu, type StandardEcuSpec, type ValueSource } from './vehicle.ts';

const bytes = (s: string) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const fixed = (s: string): ValueSource => {
  const b = bytes(s);
  return () => b;
};
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Synthetic VIN used by every demo and test vehicle (never a real car's VIN). */
export const DEMO_VIN = 'TMBDEMO0OBDCRAFT1';

/**
 * A two-ECU petrol car shaped like the 2022 Kushaq 1.0 TSI capture: same
 * advertised PIDs, reply lengths (PID 56 one byte, 6D/70 multi-frame), padding
 * (7E8 00, 7E9 AA), empty fault memory and no freeze frame. Values are fixed
 * snapshots from the capture; the demo profile replays the real time series.
 */
export function kushaqLikeSpecs(overrides: { engine?: Partial<StandardEcuSpec>; gearbox?: Partial<StandardEcuSpec> } = {}): StandardEcuSpec[] {
  const engine: StandardEcuSpec = {
    id: '7E8', requestId: '7E0', name: 'ECM-EngineControl', pad: 0x00, latencyMs: 12,
    pids: {
      0x01: fixed('00 07 E1 00'), 0x03: fixed('02 00'), 0x04: fixed('2B'), 0x05: fixed('86'), 0x06: fixed('7E'), 0x07: fixed('80'),
      0x0b: fixed('23'), 0x0c: fixed('1C 56'), 0x0d: fixed('49'), 0x0e: fixed('8A'), 0x0f: fixed('4C'), 0x11: fixed('2A'),
      0x13: fixed('03'), 0x15: fixed('5A FF'), 0x1c: fixed('20'), 0x1f: fixed('03 C7'), 0x21: fixed('00 00'), 0x2e: fixed('00'),
      0x2f: fixed('80'), 0x30: fixed('57'), 0x31: fixed('07 54'), 0x33: fixed('62'), 0x34: fixed('80 00 80 00'), 0x3c: fixed('16 A8'),
      0x41: fixed('00 07 A1 21'), 0x42: fixed('37 28'), 0x43: fixed('00 3A'), 0x44: fixed('80 00'), 0x45: fixed('10'), 0x46: fixed('42'),
      0x47: fixed('30'), 0x49: fixed('24'), 0x4a: fixed('12'), 0x4c: fixed('14'), 0x51: fixed('01'), 0x56: fixed('7F'),
      0x67: fixed('03 86 56'), 0x68: fixed('03 6E 5C 00 00 00 00'), 0x6d: fixed('02 00 00 0D D5 28 00 00 00 00 28'),
      0x70: fixed('02 00 00 0C CC 00 00 00 00 00'),
    },
    supportOverride: {
      0x00: bytes('BE 3E A8 13'), 0x20: bytes('80 07 B0 11'), 0x40: bytes('FE D0 84 01'), 0x60: bytes('03 09 00 00'),
    },
    dtcs: { stored: [], pending: [], permanent: null },
    freeze: null,
    freezeSupport: { 0x00: bytes('7E 3E 80 03'), 0x20: bytes('00 06 20 01'), 0x40: bytes('7E D0 84 01'), 0x60: bytes('03 09 00 00') },
    mode06Support: { 0x00: bytes('C0 00 00 01'), 0x20: bytes('80 00 08 09'), 0x40: bytes('C0 00 00 01'), 0x60: bytes('00 00 00 01'), 0x80: bytes('00 00 00 01'), 0xa0: bytes('70 00 00 00') },
    mode06: {
      0x01: bytes('01 81 10 00 0A 00 00 02 58 01 85 33 0F C7 00 00 38 00'),
      0x02: bytes('02 05 10 00 32 00 00 02 58 02 95 0A 17 FC 17 FC 28 00'),
      0x21: bytes('21 84 2F FF FF 27 10 FF FF'),
      0x35: bytes('35 80 9C 09 65 05 8F 09 C4'),
      0x3d: bytes('3D 8B 03 00 61 00 0F FF FF'),
      0x41: bytes('41 85 16 1D AD 1C 21 FF FF'),
      0x42: bytes('42 90 14 02 62 00 00 12 68'),
      0xa2: bytes('A2 0B 24 00 0F 00 00 FF FF A2 0C 24 00 0B 00 00 FF FF'),
      0xa3: bytes('A3 0B 24 00 0D 00 00 FF FF A3 0C 24 00 05 00 00 FF FF'),
      0xa4: bytes('A4 0B 24 00 0A 00 00 FF FF A4 0C 24 00 08 00 00 FF FF'),
    },
    mode09Support: bytes('54 40 00 00'),
    mode09: {
      0x02: [0x01, ...ascii(DEMO_VIN)],
      0x04: [0x01, ...ascii('04C906025EH38BEA'.padEnd(16, '\0'))],
      0x06: bytes('01 1A 2B 3C 4D'),
      0x0a: [0x01, ...ascii('ECM\0-EngineControl'.padEnd(20, '\0'))],
    },
    mode08: null,
    ...overrides.engine,
  };
  const gearbox: StandardEcuSpec = {
    id: '7E9', requestId: '7E1', name: 'TCM-TransmisCtrl', pad: 0xaa, latencyMs: 16,
    pids: {
      0x01: fixed('00 04 00 00'), 0x04: fixed('2B'), 0x05: fixed('86'), 0x0c: fixed('1C 56'), 0x0d: fixed('49'), 0x11: fixed('2A'),
      0x41: fixed('00 04 00 00'), 0x42: fixed('37 28'), 0x43: fixed('00 3A'), 0x49: fixed('24'),
    },
    supportOverride: { 0x00: bytes('98 18 80 01'), 0x20: bytes('00 00 00 01'), 0x40: bytes('E0 80 00 00') },
    dtcs: { stored: [], pending: [], permanent: null },
    freeze: null,
    freezeSupport: { 0x00: bytes('58 18 80 03'), 0x20: bytes('00 00 00 01'), 0x40: bytes('60 80 00 00') },
    mode09Support: bytes('14 40 00 00'),
    mode09: {
      0x04: [0x01, ...ascii('09S927158DM 3921'.padEnd(16, '\0'))],
      0x06: bytes('01 5E 6F 70 81'),
      0x0a: [0x01, ...ascii('TCM\0-TransmisCtrl'.padEnd(20, '\0'))],
    },
    mode08: null,
    ...overrides.gearbox,
  };
  return [engine, gearbox];
}

export function kushaqLikeEcus(overrides?: Parameters<typeof kushaqLikeSpecs>[0]): StandardEcu[] {
  return kushaqLikeSpecs(overrides).map((s) => new StandardEcu(s));
}
