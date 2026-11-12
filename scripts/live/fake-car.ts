/**
 * Simulated car behind the fake bridge: the recorded Kushaq demo profile's OBD-II ECUs (engine 7E8, gearbox
 * 7E9), the coding bench unit (7A0/7A8), and two fictional VAG-style UDS modules on the real car's addresses —
 * central electrics 70E/778 and instrument cluster 714/77E (the cluster serves the VIN, the BCM refuses F190
 * with NRC 31, as on the car). Every identifier is synthetic; nothing here came from a real vehicle's coding.
 *
 * So that `live apply` can run end to end, each module also hosts the DID of its app-data live proof holding
 * the proof's documented "before" byte (BCM 0A5E, cluster 0E46), takes the VAG coding markers (F199 date,
 * F198 sequence) and answers SecurityAccess 27 03/04 with a fixed synthetic seed (key = seed + login, the
 * logins the app's recipes name for that request id). The part numbers stay fake, so `live` cannot tell the car
 * from them: pass `--model kushaq`.
 *
 * For `live health` the car also has faults (src/infra/link/testing/health-car.ts): the engine reports codes, a
 * freeze frame and a failed misfire monitor, the BCM two UDS DTCs and the cluster a long DTC list, all answered
 * through ReadDTCInformation (19). A 14 (clear) is refused like every other unsupported service.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ecusFromProfile, type EcuModel, type VehicleProfile } from '@obdcraft/obd-core';
import { CodingBenchEcu } from '@obdcraft/coding';
import { APP_DATA } from '../../src/domain/catalog/data.ts';
import { SIM_VIN } from '../../src/infra/link/testing/clone-sim.ts';
import { answerReadDtc, BCM_FAULTS, CLUSTER_FAULTS, type UdsFault, withEngineFaults } from '../../src/infra/link/testing/health-car.ts';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const hex = (s: string) => (s.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));

/** Coding markers: written in the extended session without security; F199 is never readable (as on the car). */
const MARKERS = new Set([0xf198, 0xf199]);
const SEED = [0x1f, 0x2e, 0x3d, 0x4c];

/**
 * A UDS module: sessions, tester present, 22 reads, SecurityAccess 27 03/04, and 2E writes (extended session,
 * same length; data DIDs need the login when the module has one) of its DIDs and the coding markers.
 */
export class FakeUdsModule implements EcuModel {
  readonly pad = 0xaa;
  readonly latencyMs = 25;
  session = 0x01;
  unlocked = false;
  writes: { did: number; bytes: number[] }[] = [];
  /** Decimal logins a key may be built from (key = seed + login mod 2^32). */
  logins: number[] = [];
  /** The fault memory 19 ReadDTCInformation answers from. */
  faults: readonly UdsFault[] = [];
  readonly name: string;
  readonly requestId: string;
  readonly id: string;
  readonly dids: Map<number, number[]>;
  /** DID -> NRC this module answers instead of the value. */
  private readonly refused: Map<number, number>;

  constructor(name: string, requestId: string, id: string, dids: Map<number, number[]>, refused = new Map<number, number>()) {
    this.name = name;
    this.requestId = requestId;
    this.id = id;
    this.dids = dids;
    this.refused = refused;
  }

  handle(req: number[], _t: number, physical: boolean): number[] | null {
    if (!physical) return null;
    const [service = 0, a = 0, b = 0] = req;
    const did = a * 256 + b;
    if (service === 0x10 && (a === 0x01 || a === 0x03)) {
      this.session = a;
      this.unlocked = false;
      return [0x50, a, 0x00, 0x32, 0x01, 0xf4];
    }
    if (service === 0x27) {
      if (this.session !== 0x03) return [0x7f, 0x27, 0x7f];
      if (a === 0x03) return [0x67, 0x03, ...(this.unlocked ? [0, 0, 0, 0] : SEED)];
      if (a !== 0x04 || req.length !== 6) return [0x7f, 0x27, 0x13];
      const seed = SEED.reduce((v, x) => (v * 256 + x) >>> 0, 0);
      const key = req.slice(2).reduce((v, x) => (v * 256 + x) >>> 0, 0);
      if (!this.logins.some((l) => ((seed + l) >>> 0) === key)) return [0x7f, 0x27, 0x35];
      this.unlocked = true;
      return [0x67, 0x04];
    }
    if (service === 0x10) return [0x7f, 0x10, 0x12];
    if (service === 0x3e) return a === 0x80 ? null : [0x7e, 0x00];
    if (service === 0x19) return answerReadDtc(req, this.faults);
    if (service === 0x22) {
      if (req.length !== 3) return [0x7f, 0x22, 0x13];
      const nrc = this.refused.get(did) ?? (did === 0xf199 ? 0x31 : undefined);
      if (nrc) return [0x7f, 0x22, nrc];
      const value = this.dids.get(did);
      return value ? [0x62, a, b, ...value] : [0x7f, 0x22, 0x31];
    }
    if (service === 0x2e) {
      if (this.session !== 0x03) return [0x7f, 0x2e, 0x7f];
      if (MARKERS.has(did)) {
        this.dids.set(did, req.slice(3));
        this.writes.push({ did, bytes: req.slice(3) });
        return [0x6e, a, b];
      }
      const value = this.dids.get(did);
      if (!value) return [0x7f, 0x2e, 0x31];
      if (this.logins.length && !this.unlocked) return [0x7f, 0x2e, 0x33];
      if (req.length !== value.length + 3) return [0x7f, 0x2e, 0x13];
      this.dids.set(did, req.slice(3));
      this.writes.push({ did, bytes: req.slice(3) });
      return [0x6e, a, b];
    }
    return [0x7f, service, 0x11];
  }
}

function identity(part: string, sw: string, hw: string, odx: string): [number, number[]][] {
  return [
    [0xf187, ascii(part)], [0xf189, ascii(sw)], [0xf191, ascii(hw)], [0xf19e, ascii(odx)], [0xf1a2, ascii('001001')],
    [0xf199, [0x26, 0x01, 0x15]], [0xf1a5, [0, 0, 0, 0, 0, 0]],
  ];
}

/** Every login the app's recipes name for a request id (the module accepts any of them). */
function loginsFor(request: string): number[] {
  const out = new Set<number>();
  for (const r of Object.values(APP_DATA.recipes)) if (r.requestId === request && r.password && /^\d+$/.test(r.password)) out.add(Number(r.password));
  return [...out];
}

export function fakeBcm(): FakeUdsModule {
  const m = new FakeUdsModule('central electrics (fake)', '70E', '778', new Map([
    ...identity('FAKE937089A', 'F001', 'H01', 'EV_FakeBCM_001'),
    // Workshop code (the vendor default the writer falls back to): what `live frametest` writes and restores.
    [0xf198, hex('0181C8F63039')],
    [0x0600, hex('0A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D5E6F7081')],
    // lane-change blinks: byte 0 holds the proof's "before" 3A
    [0x0a5e, hex('3A00000000')],
  ]), new Map([[0xf190, 0x31]]));
  m.logins = loginsFor('70E');
  m.faults = BCM_FAULTS;
  return m;
}

export function fakeCluster(): FakeUdsModule {
  const m = new FakeUdsModule('instrument cluster (fake)', '714', '77E', new Map([
    ...identity('FAKE920310', 'F002', 'H02', 'EV_FakeCluster_001'),
    // A plausible synthetic VIN (the app refuses an implausible one): the live kit never uploads its sessions.
    [0xf190, ascii(SIM_VIN)],
    [0x0600, hex('00000000000000000000')],
    [0x6001, hex('000000')],
    // India speed chime: the proof's "before" 31
    [0x0e46, hex('31')],
  ]));
  m.logins = loginsFor('714');
  m.faults = CLUSTER_FAULTS;
  return m;
}

const DEMO_PROFILE = fileURLToPath(new URL('../../fixtures/demo/kushaq-demo.profile.json', import.meta.url));

export function loadProfile(path = DEMO_PROFILE): VehicleProfile {
  return JSON.parse(readFileSync(path, 'utf8')) as VehicleProfile;
}

export function fakeCarEcus(profile: VehicleProfile): { ecus: EcuModel[]; modules: FakeUdsModule[] } {
  const modules = [fakeBcm(), fakeCluster()];
  // The engine (7E8) answers the health snapshot's fault reads from the synthetic faulty engine; live data stays the
  // recorded drive.
  const obd = ecusFromProfile(profile).map((e): EcuModel =>
    e.id === '7E8' ? withVwMeasuring(withEngineFaults(e), ENGINE_MEASURES) : e.id === '7E9' ? withVwMeasuring(e, GEARBOX_MEASURES) : e,
  );
  return { ecus: [...obd, new CodingBenchEcu(), ...modules], modules };
}

/** A synthetic measuring value: the data bytes after 62 <DID> at time t (s). */
type Measure = (t: number) => number[];
const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const s16 = (v: number) => u16(v < 0 ? v + 0x10000 : v);
const wave = (t: number, period: number) => (Math.sin((2 * Math.PI * t) / period) + 1) / 2;

/**
 * VW measuring values (`live vwread` / `vwlog`) on the fake engine: a few of the candidate DIDs of
 * src/domain/health/vwmeasure.ts with synthetic, plausible values. Every other 22 is NRC 31, as a VW unit answers
 * an identifier it does not have; F4xx mirrors the engine's own mode 01 PID xx.
 */
const ENGINE_MEASURES = new Map<number, Measure>([
  [0x10e0, () => [0x00, 0x00, 0x6b, 0x19]], // odometer 27417 km
  [0x13f4, (t) => [Math.round(128 + 6 * wave(t, 7)), 0xe6]], // IGA_CYL_KNK[2]: 0..2.25 °CA
  [0x11f0, (t) => u16(Math.round((990 + 600 * wave(t, 20)) / 0.078125))], // charge pressure actual, hPa
  [0x11f1, (t) => u16(Math.round((1000 + 620 * wave(t, 20)) / 0.078125))], // charge pressure specified, hPa
  [0x11dd, (t) => u16(Math.round((600 + 500 * wave(t, 20)) / 0.078125))], // manifold pressure specified, hPa
  [0x11dc, (t) => u16(Math.round((590 + 500 * wave(t, 20)) / 0.078125))], // manifold pressure actual, hPa
  [0x11d5, (t) => s16(Math.round(1400 * Math.sin(t / 3)))], // rail pressure regulation error
  [0x120e, () => u16(241)],
  [0x120f, () => u16(199)],
  [0x1210, () => u16(222)],
  [0x114f, () => u16(29725)],
  [0x1150, () => u16(28100)],
  [0x1151, () => u16(18676)],
]);
const GEARBOX_MEASURES = new Map<number, Measure>([
  [0x0301, () => [0x78]], // 80 °C
  [0x1029, (t) => u16(Math.round(4000 + 3000 * wave(t, 15)))], // N371 lock-up current, 0.1 mA
]);

/**
 * Wraps an OBD-II ECU with UDS 22 measuring values: F4xx = its mode 01 PID xx, the given DIDs, NRC 31 for the rest;
 * 10 01 / 10 03 and 3E answered. Everything else goes to the ECU unchanged.
 */
export function withVwMeasuring(ecu: EcuModel, measures: ReadonlyMap<number, Measure>): EcuModel {
  return {
    id: ecu.id,
    requestId: ecu.requestId,
    pad: ecu.pad,
    latencyMs: ecu.latencyMs,
    handle(req, t, physical) {
      const [svc, a = 0, b = 0] = req;
      if (svc === 0x22 && physical) {
        if (req.length !== 3) return [0x7f, 0x22, 0x13];
        const did = a * 256 + b;
        const m = measures.get(did);
        if (m) return [0x62, a, b, ...m(t)];
        if (a === 0xf4) {
          const r = ecu.handle([0x01, b], t, true);
          return r && r[0] === 0x41 ? [0x62, a, b, ...r.slice(2)] : [0x7f, 0x22, 0x31];
        }
        return ecu.handle(req, t, physical)?.[0] === 0x62 ? ecu.handle(req, t, physical) : [0x7f, 0x22, 0x31];
      }
      if (svc === 0x10 && physical && req.length === 2 && (a === 0x01 || a === 0x03)) return [0x50, a, 0x00, 0x32, 0x01, 0xf4];
      if (svc === 0x3e && physical && req.length === 2) return a === 0x80 ? null : [0x7e, 0x00];
      return ecu.handle(req, t, physical);
    },
  };
}
