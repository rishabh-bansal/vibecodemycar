import { StandardEcu, type StandardEcuSpec, type ValueSource } from './vehicle.ts';
import { DEMO_VIN, kushaqLikeSpecs } from './presets.ts';

/**
 * Emulated cars beyond the Kushaq, one per thing that differs between real
 * OBD-II cars: 29-bit CAN, diesel aftertreatment, several ECUs, K-line and
 * J1850, and a car that supports very little. Each states what a correct scan
 * must find, so one test can hold the engine to all of them.
 */
export interface CarProfile {
  id: string;
  name: string;
  /** ELM protocol number. */
  protocol: number;
  specs: () => StandardEcuSpec[];
  expect: {
    family: 'can11' | 'can29' | 'legacy';
    engineEcu: string;
    ecus: string[];
    /** ecu -> stored codes */
    stored: Record<string, string[]>;
    pending?: Record<string, string[]>;
    vin: string | null;
    freezeDtc?: string;
    engineType: 'spark' | 'compression';
  };
}

const bytes = (s: string) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const fixed = (s: string): ValueSource => {
  const b = bytes(s);
  return () => b;
};
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
/** Smooth value between lo and hi (period in seconds), encoded by enc. */
const wave = (lo: number, hi: number, period: number, enc: (v: number) => number[]): ValueSource =>
  (t) => enc(lo + ((hi - lo) * (1 + Math.sin((2 * Math.PI * t) / period))) / 2);
const u8 = (v: number) => [Math.max(0, Math.min(255, Math.round(v)))];
const u16 = (v: number) => {
  const x = Math.max(0, Math.min(65535, Math.round(v)));
  return [x >> 8, x & 0xff];
};
const rpm = (lo: number, hi: number, period = 23) => wave(lo, hi, period, (v) => u16(v * 4));
const speed = (lo: number, hi: number, period = 41) => wave(lo, hi, period, u8);
const pct = (lo: number, hi: number, period = 17) => wave(lo, hi, period, (v) => u8((v * 255) / 100));
const name20 = (s: string) => [0x01, ...ascii(s.padEnd(20, '\0'))];
const calid = (s: string) => [0x01, ...ascii(s.padEnd(16, '\0'))];

/** CAN 29-bit petrol (protocol 7): ECUs 18DAF110 / 18DAF118, four stored codes (multi-frame 43 reply). */
function petrol29(): StandardEcuSpec[] {
  return [
    {
      id: '18DAF110', requestId: '18DA10F1', name: 'ECM', pad: 0xaa, latencyMs: 14,
      pids: {
        0x01: fixed('84 07 65 00'), 0x03: fixed('02 00'), 0x04: pct(15, 60), 0x05: fixed('7B'), 0x06: fixed('82'), 0x07: fixed('7E'),
        0x0b: wave(30, 95, 19, u8), 0x0c: rpm(750, 3200), 0x0d: speed(0, 90), 0x0e: fixed('90'), 0x0f: fixed('48'),
        0x10: wave(2, 25, 23, (v) => u16(v * 100)), 0x11: pct(12, 55), 0x13: fixed('03'), 0x1c: fixed('01'), 0x1f: wave(0, 3600, 3600, u16),
        0x21: fixed('00 00'), 0x2f: fixed('A0'), 0x31: fixed('12 34'), 0x33: fixed('63'), 0x42: fixed('38 40'), 0x46: fixed('44'),
        0x49: pct(14, 60), 0x51: fixed('01'), 0x5c: fixed('6E'), 0xa6: fixed('00 01 E2 40'),
      },
      dtcs: { stored: ['P0171', 'P0300', 'P0420', 'P0128'], pending: ['P0300'], permanent: ['P0420'] },
      freeze: { dtc: 'P0300', values: { 0x04: bytes('40'), 0x05: bytes('7A'), 0x0c: bytes('0B B8'), 0x0d: bytes('2D') } },
      freezeSupport: { 0x00: bytes('58 18 00 00') },
      mode06: { 0x01: bytes('01 81 10 00 0A 00 00 02 58') },
      mode09Support: bytes('54 40 00 00'),
      mode09: { 0x02: [0x01, ...ascii(DEMO_VIN)], 0x04: calid('ECM29CAL0001'), 0x06: bytes('01 11 22 33 44'), 0x0a: name20('ECM\0-EngineControl') },
    },
    {
      id: '18DAF118', requestId: '18DA18F1', name: 'TCM', pad: 0x55, latencyMs: 18,
      pids: { 0x01: fixed('00 04 00 00'), 0x0c: rpm(750, 3200), 0x0d: speed(0, 90), 0xa4: fixed('01 30 0A F0') },
      dtcs: { stored: [], pending: [], permanent: [] },
      mode09Support: bytes('14 40 00 00'),
      mode09: { 0x04: calid('TCM29CAL0001'), 0x06: bytes('01 55 66 77 88'), 0x0a: name20('TCM\0-TransmisCtrl') },
    },
  ];
}

/** Turbo diesel with DPF, EGR, NOx sensors and AdBlue; a glow-plug fault stored, DPF soot pending. */
function diesel(): StandardEcuSpec[] {
  return [
    {
      id: '7E8', requestId: '7E0', name: 'ECM-DieselCtrl', pad: 0x55, latencyMs: 15,
      pids: {
        // byte B bit 3 = compression ignition; C: NMHC, NOx/SCR, boost, exhaust sensor, PM filter, EGR; D: PM filter not ready
        0x01: fixed('81 0F EB 40'), 0x04: pct(10, 70), 0x05: fixed('82'), 0x0b: wave(100, 210, 19, u8), 0x0c: rpm(800, 2800),
        0x0d: speed(0, 80), 0x0f: fixed('3C'), 0x10: wave(8, 60, 23, (v) => u16(v * 100)), 0x1c: fixed('06'), 0x1f: wave(0, 3600, 3600, u16),
        0x21: fixed('00 00'), 0x23: wave(25000, 160000, 19, (v) => u16(v / 10)), 0x2c: pct(0, 40), 0x2d: fixed('80'), 0x30: fixed('20'),
        0x31: fixed('03 E8'), 0x33: fixed('62'), 0x42: fixed('37 A0'), 0x46: fixed('46'), 0x49: pct(14, 60), 0x51: fixed('04'),
        0x5c: fixed('78'), 0x5e: wave(1, 12, 23, (v) => u16(v * 20)), 0x61: wave(130, 200, 17, u8), 0x62: wave(130, 195, 17, u8), 0x63: fixed('01 90'),
        0x6b: fixed('01 82 00 00 00'), 0x70: fixed('03 07 D0 07 A8 00 00 00 00 00'), 0x73: fixed('01 27 10 00 00'),
        0x78: fixed('03 11 94 0E D8 00 00 00 00'), 0x7a: fixed('07 00 C8 27 10 26 48'), 0x7c: fixed('03 14 50 13 88 00 00 00 00'),
        0x7d: fixed('00'), 0x7e: fixed('00'), 0x7f: fixed('07 00 00 3A 98 00 00 0B B8 00 00 00 00'),
        0x83: fixed('03 00 50 00 0A 00 00 00 00'), 0x85: fixed('0F 00 14 00 15 B3 00 00 00 00'), 0x86: fixed('01 00 08 00 00'),
        0x8b: fixed('07 00 32 01 2C 00 FA'), 0xa5: fixed('01 2A 00 00'), 0xa6: fixed('00 02 49 F0'),
        // not in any public table: shown as raw bytes
        0x95: fixed('12 34'),
      },
      dtcs: { stored: ['P0671'], pending: ['P2463'], permanent: ['P0671'] },
      freeze: { dtc: 'P0671', values: { 0x05: bytes('2E'), 0x0c: bytes('03 20'), 0x0d: bytes('00'), 0x04: bytes('14') } },
      freezeSupport: { 0x00: bytes('58 18 00 00') },
      mode09Support: bytes('54 40 00 00'),
      mode09: { 0x02: [0x01, ...ascii(DEMO_VIN)], 0x04: calid('DSL1.5CAL0042'), 0x06: bytes('01 DE AD BE EF'), 0x0a: name20('ECM\0-DieselCtrl') },
    },
  ];
}

/** Petrol hybrid with four ECUs: engine, gearbox, hybrid controller (7EA) and brakes (7EB), each with its own codes. */
function hybridFourEcus(): StandardEcuSpec[] {
  const [engine, gearbox] = kushaqLikeSpecs();
  return [
    { ...engine!, pids: { ...engine!.pids, 0x01: fixed('81 07 E1 00') }, dtcs: { stored: ['P0420'], pending: [], permanent: ['P0420'] } },
    { ...gearbox!, dtcs: { stored: [], pending: ['P0700'], permanent: null } },
    {
      id: '7EA', requestId: '7E2', name: 'HPCM-HybridCtrl', pad: 0x00, latencyMs: 20,
      pids: { 0x01: fixed('00 04 00 00'), 0x5b: wave(40, 80, 60, (v) => u8((v * 255) / 100)), 0x9a: fixed('0F 0E 10 00 C8 3E') },
      dtcs: { stored: ['P0A80'], pending: [], permanent: ['P0A80'] },
      mode09Support: bytes('00 40 00 00'),
      mode09: { 0x0a: name20('HPCM\0-HybridCtrl') },
    },
    {
      id: '7EB', requestId: '7E3', name: 'ABS-BrakeCtrl', pad: 0x00, latencyMs: 22,
      pids: { 0x01: fixed('00 04 00 00'), 0x0d: speed(0, 90), 0xa9: fixed('01 00 00 00') },
      dtcs: { stored: ['C0035'], pending: [], permanent: null },
      mode09Support: bytes('00 40 00 00'),
      mode09: { 0x0a: name20('ABS\0-BrakeCtrl') },
    },
  ];
}

/** Pre-2010 petrol on K-line or J1850: one ECU (source address 10), MIL on, four stored codes (two 43 messages). */
function kLine(): StandardEcuSpec[] {
  return [
    {
      id: '10', requestId: '', name: 'ECM', latencyMs: 45,
      pids: {
        0x01: fixed('84 07 65 00'), 0x03: fixed('02 00'), 0x04: pct(15, 60), 0x05: fixed('7C'), 0x06: fixed('80'), 0x07: fixed('7F'),
        0x0c: rpm(800, 3000), 0x0d: speed(0, 70), 0x0e: fixed('8C'), 0x0f: fixed('46'), 0x11: pct(12, 50), 0x13: fixed('03'),
        0x14: fixed('5A 80'), 0x15: fixed('5C FF'), 0x1c: fixed('06'),
      },
      dtcs: { stored: ['P0301', 'P0302', 'P0420', 'P0171'], pending: ['P0300'], permanent: null },
      freeze: { dtc: 'P0301', values: { 0x04: bytes('33'), 0x05: bytes('7A'), 0x0c: bytes('0A 28'), 0x0d: bytes('28') } },
      freezeSupport: { 0x00: bytes('58 18 00 00') },
      mode09Support: bytes('50 00 00 00'),
      mode09: { 0x02: [0x01, ...ascii(DEMO_VIN)], 0x04: calid('KLINECAL0007') },
      maxMultiPid: 1,
    },
  ];
}

/** Basic car: one ECU, eight PIDs, no service 09, no freeze frame support, no permanent codes. */
function minimal(): StandardEcuSpec[] {
  return [
    {
      id: '7E8', requestId: '7E0', name: 'ECM', latencyMs: 25,
      pids: { 0x01: fixed('00 07 61 00'), 0x04: pct(15, 50), 0x05: fixed('7A'), 0x0c: rpm(800, 2500), 0x0d: speed(0, 60), 0x0f: fixed('40'), 0x11: pct(12, 40), 0x1c: fixed('06') },
      dtcs: { stored: [], pending: [], permanent: null },
      maxMultiPid: 1,
    },
  ];
}

const legacyNames: Record<number, string> = {
  1: 'Older petrol, SAE J1850 PWM', 2: 'Older petrol, SAE J1850 VPW', 3: 'Older petrol, ISO 9141-2 (K-line)',
  4: 'Older petrol, ISO 14230 KWP (slow init)', 5: 'Older petrol, ISO 14230 KWP (fast init)',
};

export const CAR_PROFILES: CarProfile[] = [
  {
    id: 'petrol-can29', name: 'Petrol, CAN 29-bit, four fault codes', protocol: 7, specs: petrol29,
    expect: {
      family: 'can29', engineEcu: '18DAF110', ecus: ['18DAF110', '18DAF118'], stored: { '18DAF110': ['P0171', 'P0300', 'P0420', 'P0128'], '18DAF118': [] },
      pending: { '18DAF110': ['P0300'] }, vin: DEMO_VIN, freezeDtc: 'P0300', engineType: 'spark',
    },
  },
  {
    id: 'petrol-can29-250k', name: 'Petrol, CAN 29-bit 250 kbaud', protocol: 9, specs: petrol29,
    expect: {
      family: 'can29', engineEcu: '18DAF110', ecus: ['18DAF110', '18DAF118'], stored: { '18DAF110': ['P0171', 'P0300', 'P0420', 'P0128'], '18DAF118': [] },
      vin: DEMO_VIN, freezeDtc: 'P0300', engineType: 'spark',
    },
  },
  {
    id: 'diesel-dpf', name: 'Turbo diesel with DPF, EGR, NOx and AdBlue (glow-plug fault)', protocol: 6, specs: diesel,
    expect: {
      family: 'can11', engineEcu: '7E8', ecus: ['7E8'], stored: { '7E8': ['P0671'] }, pending: { '7E8': ['P2463'] },
      vin: DEMO_VIN, freezeDtc: 'P0671', engineType: 'compression',
    },
  },
  {
    id: 'hybrid-4ecu', name: 'Petrol hybrid, four ECUs answering', protocol: 6, specs: hybridFourEcus,
    expect: {
      family: 'can11', engineEcu: '7E8', ecus: ['7E8', '7E9', '7EA', '7EB'],
      stored: { '7E8': ['P0420'], '7E9': [], '7EA': ['P0A80'], '7EB': ['C0035'] }, pending: { '7E9': ['P0700'] },
      vin: DEMO_VIN, engineType: 'spark',
    },
  },
  ...[3, 4, 5, 1, 2].map((p): CarProfile => ({
    id: `petrol-legacy-${p}`, name: legacyNames[p]!, protocol: p, specs: kLine,
    expect: {
      family: 'legacy', engineEcu: '10', ecus: ['10'], stored: { '10': ['P0301', 'P0302', 'P0420', 'P0171'] }, pending: { '10': ['P0300'] },
      vin: DEMO_VIN, freezeDtc: 'P0301', engineType: 'spark',
    },
  })),
  {
    id: 'minimal', name: 'Basic car: eight PIDs, nothing else', protocol: 8, specs: minimal,
    expect: { family: 'can11', engineEcu: '7E8', ecus: ['7E8'], stored: { '7E8': [] }, vin: null, engineType: 'spark' },
  },
];

export function carProfile(id: string): CarProfile | undefined {
  return CAR_PROFILES.find((p) => p.id === id);
}

export function profileEcus(p: CarProfile): StandardEcu[] {
  return p.specs().map((s) => new StandardEcu(s));
}
