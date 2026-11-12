import {
  type EcuModel,
  Elm327Emulator,
  kushaqLikeEcus,
  realClock,
  type Transport,
  TransportError,
} from '@obdcraft/obd-core';
import { deviceClassFromAppearance, type ScannedDevice } from '../../domain/adapters/likely.ts';
import { type BleScanner, ScanError, type ScanHandle } from './scanner.ts';

/**
 * A scanner with no radio, for tests and for reviewing the picker in development (`?scanner=fake`). It reports
 * a scripted set of nearby devices over time, with the signal drifting like a real scan. Connecting runs the
 * real ELM327 handshake against the in-browser emulator (an adapter) or against a device that never answers
 * or has no serial service (not an adapter).
 */

export type FakeScenario = 'adapters' | 'off' | 'denied' | 'empty';

/** How a fake device behaves when the app connects to it. */
export type FakeBehaviour = 'adapter' | 'silent' | 'no-serial';

export interface FakeDevice extends ScannedDevice {
  /** ms after the scan starts when the device is first seen. */
  at: number;
  behaviour: FakeBehaviour;
}

const svc = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;

/** What a car park next to a phone might look like: two adapters, a weak clone, earphones, a watch, noise. */
export const FAKE_DEVICES: readonly FakeDevice[] = [
  {
    id: 'fake-obdble',
    name: 'OBDBLE',
    rssi: -58,
    serviceUuids: [svc('fff0')],
    at: 400,
    behaviour: 'adapter',
  },
  {
    id: 'fake-earbuds',
    name: 'boAt Airdopes 141',
    rssi: -49,
    serviceUuids: [],
    deviceClass: deviceClassFromAppearance(0x0941), // wearable audio: earbud
    at: 300,
    behaviour: 'no-serial',
  },
  {
    id: 'fake-vlinker',
    name: 'vLinker MC-IOS',
    rssi: -71,
    serviceUuids: [svc('18f0')],
    at: 1100,
    behaviour: 'adapter',
  },
  { id: 'fake-unnamed', rssi: -77, serviceUuids: [], at: 1600, behaviour: 'silent' },
  {
    id: 'fake-watch',
    name: 'Galaxy Watch5 (OBD7)',
    rssi: -64,
    serviceUuids: [],
    deviceClass: deviceClassFromAppearance(0x00c1), // watch
    at: 2200,
    behaviour: 'no-serial',
  },
  { id: 'fake-clone', name: 'OBDII', rssi: -86, serviceUuids: [svc('ffe0')], at: 3000, behaviour: 'silent' },
  { id: 'fake-tv', name: 'Mi TV Stick', rssi: -69, serviceUuids: [], at: 3800, behaviour: 'no-serial' },
];

export interface FakeScannerOptions {
  scenario?: FakeScenario;
  devices?: readonly FakeDevice[];
  /** Repeat sightings every `repeatMs` with the signal drifting ±`drift` dBm (0 = no repeats). */
  repeatMs?: number;
  drift?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  /** How long a "no serial service" device takes to refuse (ms). */
  refuseMs?: number;
  /** How long a silent device stays connected before it drops the link (ms); `null` = it never drops. */
  dropMs?: number | null;
}

/** A tiny car for the emulator: the body computer and the cluster answer the VIN and part-number reads. */
class FakeModule implements EcuModel {
  readonly pad = 0x55;
  readonly latencyMs = 15;
  readonly requestId: string;
  readonly id: string;
  private readonly dids: Record<number, string>;
  constructor(requestId: string, id: string, dids: Record<number, string>) {
    this.requestId = requestId;
    this.id = id;
    this.dids = dids;
  }
  handle(req: number[], _t: number, physical: boolean): number[] | null {
    if (!physical) return null;
    if (req[0] === 0x10) return [0x50, req[1] ?? 0, 0x00, 0x32, 0x01, 0xf4];
    if (req[0] === 0x3e) return [0x7e, 0x00];
    if (req[0] !== 0x22) return [0x7f, req[0] ?? 0, 0x11];
    const did = ((req[1] ?? 0) << 8) | (req[2] ?? 0);
    const value = this.dids[did];
    return value === undefined
      ? [0x7f, 0x22, 0x31]
      : [0x62, req[1] ?? 0, req[2] ?? 0, ...[...value].map((c) => c.charCodeAt(0))];
  }
}

const FAKE_VIN = 'MEXTEST0FAKE00001';

function emulatedAdapter(device: ScannedDevice): Transport {
  return new Elm327Emulator({
    clock: realClock,
    ecus: [
      ...kushaqLikeEcus(),
      new FakeModule('70E', '778', { 61831: '2Q0937089D' }),
      new FakeModule('714', '77E', { 61840: FAKE_VIN, 61831: '2GJ920700A' }),
    ],
    protocol: 6,
    voltage: () => 12.6,
    name: device.name ?? 'Fake adapter',
    id: device.id,
  });
}

/**
 * Opens like a BLE serial device but never answers a command. With `dropMs` the device drops the connection
 * after that long (as cheap modules do when nothing they understand arrives); without, the handshake times out.
 */
class SilentTransport implements Transport {
  readonly kind = 'ble' as const;
  readonly maxWrite = 20;
  isOpen = false;
  readonly name: string;
  readonly id: string;
  private readonly closeCbs = new Set<(reason: string) => void>();
  private readonly dropMs: number | undefined;
  private dropTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(name: string, id: string, dropMs?: number) {
    this.name = name;
    this.id = id;
    this.dropMs = dropMs;
  }
  async open() {
    this.isOpen = true;
    if (this.dropMs !== undefined)
      this.dropTimer = setTimeout(() => this.ended('the adapter disconnected'), this.dropMs);
  }
  async close() {
    this.ended('closed by the app');
  }
  private ended(reason: string) {
    clearTimeout(this.dropTimer);
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const cb of this.closeCbs) cb(reason);
  }
  async write() {
    if (!this.isOpen) throw new TransportError('not connected', 'closed');
  }
  onData() {
    return () => {};
  }
  onClose(cb: (reason: string) => void) {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
}

/** Connects at the GATT level, then has no serial service: refused before any command is sent. */
class NoSerialTransport extends SilentTransport {
  private readonly refuseMs: number;
  constructor(name: string, id: string, refuseMs: number) {
    super(name, id);
    this.refuseMs = refuseMs;
  }
  override async open() {
    await new Promise((r) => setTimeout(r, this.refuseMs));
    throw new TransportError('this device does not offer a known ELM327 serial service', 'gatt');
  }
}

export function fakeScanner(options: FakeScannerOptions = {}): BleScanner & { readonly scans: number } {
  const {
    scenario = 'adapters',
    devices = FAKE_DEVICES,
    repeatMs = 1200,
    drift = 4,
    random = Math.random,
    refuseMs = 900,
    dropMs = 4000,
  } = options;
  const later = options.setTimeout ?? ((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms));
  const cancel =
    options.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const byId = new Map(devices.map((d) => [d.id, d]));
  let scans = 0;

  return {
    ui: 'in-app',
    get scans() {
      return scans;
    },
    scan(onSeen, onError): ScanHandle {
      scans += 1;
      const timers = new Set<unknown>();
      let stopped = false;
      const at = (ms: number, cb: () => void) => {
        const h = later(() => {
          timers.delete(h);
          if (!stopped) cb();
        }, ms);
        timers.add(h);
      };
      if (scenario === 'off') at(150, () => onError(new ScanError('bluetooth-off', 'Bluetooth is off.')));
      else if (scenario === 'denied')
        at(150, () => onError(new ScanError('permission-denied', 'Bluetooth permission refused.')));
      else if (scenario === 'adapters') {
        for (const d of devices) {
          const { at: firstAt, behaviour: _b, ...seen } = d;
          at(firstAt, () => onSeen(seen));
          if (repeatMs > 0) {
            const again = (n: number) =>
              at(repeatMs, () => {
                const jitter = Math.round((random() * 2 - 1) * drift);
                onSeen({ ...seen, ...(seen.rssi !== undefined ? { rssi: seen.rssi + jitter } : {}) });
                if (n < 50) again(n + 1);
              });
            at(firstAt, () => again(1));
          }
        }
      }
      return {
        stop() {
          stopped = true;
          for (const h of timers) cancel(h);
          timers.clear();
        },
      };
    },
    transport(device) {
      const behaviour = byId.get(device.id)?.behaviour ?? 'silent';
      const name = device.name ?? 'Bluetooth device';
      if (behaviour === 'adapter') return emulatedAdapter(device);
      if (behaviour === 'no-serial') return new NoSerialTransport(name, device.id, refuseMs);
      return new SilentTransport(name, device.id, dropMs ?? undefined);
    },
    openSettings() {
      // Nothing to open in a browser; the fake only shows that the button is wired.
    },
  };
}
