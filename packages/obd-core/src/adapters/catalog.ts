/**
 * What is known about ELM327-family hardware before a single command is sent: how adapters name
 * themselves over BLE, which GATT layouts they use, where WiFi dongles listen, which serial speeds
 * to try. Merged from the adapter-id kit and OBDCraft's own BLE list; where the two disagree both
 * variants are kept as candidates and the connection picks by what the device actually exposes.
 */

const base = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;

/* ---------------------------------------------------------------- BLE layouts */

export interface BleLayout {
  name: string;
  service: string;
  /** Characteristic candidates in the order to try. A candidate matches only if the device gives it the right properties. */
  write: string[];
  notify: string[];
  source: string;
}

export const BLE_LAYOUTS: BleLayout[] = [
  {
    name: 'FFF0 (OBDBLE / Vgate / vLinker style)', service: base('fff0'),
    write: [base('fff2'), base('fff1')], notify: [base('fff1'), base('fff2')],
    source: 'verified on the OBDBLE clone; write/notify swap from the adapter-id kit',
  },
  { name: 'FFE0 (HM-10 style)', service: base('ffe0'), write: [base('ffe1')], notify: [base('ffe1')], source: 'adapter-id kit, community' },
  { name: 'FFE5 / FFE9', service: base('ffe5'), write: [base('ffe9')], notify: [base('ffe9')], source: 'adapter-id kit (some BLE 4.0 clones), unverified' },
  { name: '18F0 (vLinker / OBDLink style)', service: base('18f0'), write: [base('2af1')], notify: [base('2af0')], source: 'community' },
  {
    name: 'E781 (OBDLink CX / Veepeak style)', service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    // OBDCraft lists a single read/write/notify characteristic; the kit lists a write/notify pair. Neither is verified here.
    write: ['bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', 'e7810a72-73ae-499d-8c15-faa9aef0c3f2'],
    notify: ['bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', 'e7810a73-73ae-499d-8c15-faa9aef0c3f2'],
    source: 'community (single characteristic) and adapter-id kit (pair): both tried',
  },
  {
    name: 'ISSC transparent serial', service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    write: ['49535343-8841-43f4-a8d4-ecbe34729bb3'], notify: ['49535343-1e4d-4bd9-ba61-23c647249616'],
    source: 'adapter-id kit (several iCar clones), unverified',
  },
  { name: 'BEEF (generic)', service: base('beef'), write: [base('beef')], notify: [base('beef')], source: 'community' },
];

/** Every service the browser must be told about up front; Web Bluetooth refuses services that were not declared. */
export const BLE_SERVICES: string[] = BLE_LAYOUTS.map((l) => l.service);

export interface GattCharInfo {
  uuid: string;
  properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean; indicate: boolean };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const canWrite = (c: GattCharInfo) => c.properties.write || c.properties.writeWithoutResponse;
const canNotify = (c: GattCharInfo) => c.properties.notify || c.properties.indicate;

/**
 * Picks the write and notify characteristics of one service. Known candidates come first, each only if
 * the device really gives it that ability; failing that, the first characteristic that can notify and the
 * first that can be written (they may be the same one). `via` says which route found them.
 */
export function pickCharacteristics<T extends GattCharInfo>(layout: BleLayout, chars: T[]): { write: T; notify: T; via: 'known' | 'by-properties' } | null {
  let write: T | undefined;
  let notify: T | undefined;
  for (const u of layout.write) {
    write = chars.find((c) => same(c.uuid, u) && canWrite(c));
    if (write) break;
  }
  for (const u of layout.notify) {
    notify = chars.find((c) => same(c.uuid, u) && canNotify(c));
    if (notify) break;
  }
  if (write && notify) return { write, notify, via: 'known' };
  const w = chars.find(canWrite);
  const n = chars.find(canNotify);
  return w && n ? { write: w, notify: n, via: 'by-properties' } : null;
}

/* ------------------------------------------------------------------ BLE names */

export type NameHint = 'stn-likely' | 'elm' | 'app-gated';

export interface NameRule {
  pattern: RegExp;
  vendor: string;
  hint: NameHint;
}

/** First match wins; the generic patterns come last. Cheap clones name themselves anything ("OBDII", "V011", "Android-Bluetooth"). */
export const BLE_NAME_RULES: NameRule[] = [
  { pattern: /vlinker|v-link|vlink/i, vendor: 'vlinker', hint: 'stn-likely' },
  { pattern: /obdlink|obd-link|obdx|scanlx/i, vendor: 'obdlink', hint: 'stn-likely' },
  { pattern: /veepeak/i, vendor: 'veepeak', hint: 'elm' },
  { pattern: /konnwei|kw9\d\d/i, vendor: 'konnwei', hint: 'elm' },
  { pattern: /vgate|icar|icarpro/i, vendor: 'vgate', hint: 'elm' },
  { pattern: /iobd2|iobd/i, vendor: 'xtool', hint: 'elm' },
  { pattern: /nexas|nexpeak/i, vendor: 'nexas', hint: 'elm' },
  { pattern: /thinkdiag|topdon/i, vendor: 'thinkdiag', hint: 'app-gated' },
  { pattern: /elm327|elm-327|elm/i, vendor: 'generic', hint: 'elm' },
  { pattern: /obd\s*ii|obd2|obd/i, vendor: 'generic', hint: 'elm' },
  // the kit's pattern was /v\d{2,3}h|bt\d|ble|.../, which missed its own example "V011" and matched any name containing "ble" ("Portable", "Cable")
  { pattern: /^v\d{2,3}h?$|\bbt\d|\bble\b|android-bluetooth/i, vendor: 'generic', hint: 'elm' },
];

export interface NameInfo {
  vendor: string;
  hint: NameHint;
  /** False for adapters that only talk to their own app (ThinkDiag, Topdon): they are not ELM327-compatible. */
  elmCompatible: boolean;
}

export function classifyBleName(name: string | undefined): NameInfo | undefined {
  if (!name) return undefined;
  const rule = BLE_NAME_RULES.find((r) => r.pattern.test(name));
  return rule ? { vendor: rule.vendor, hint: rule.hint, elmCompatible: rule.hint !== 'app-gated' } : undefined;
}

/* ------------------------------------------------------------------- WiFi, USB */

export interface WifiEndpoint {
  host: string;
  port: number;
  notes: string;
}

/** Where WiFi dongles listen. Reached through a WebSocket-to-TCP bridge from a browser, directly from a native shell. */
export const WIFI_DEFAULTS: WifiEndpoint[] = [
  { host: '192.168.0.10', port: 35000, notes: 'standard ELM WiFi dongle' },
  { host: '192.168.4.1', port: 23, notes: 'some ESP8266-based clones' },
  { host: '192.168.1.10', port: 35000, notes: 'alternate subnet variant (unverified)' },
];

/** ELM327 default is 38400 (some units 9600); STN-based USB cables run 115200 or faster. A connected adapter answers within about a second. */
export const SERIAL_BAUDS: number[] = [38400, 115200, 9600, 57600, 230400];

/** USB-serial bridge chips seen inside OBD cables. All of them look the same at the AT layer. */
export function describeUsbChip(vendorId?: number): string | undefined {
  if (vendorId === 0x1a86) return 'CH340';
  if (vendorId === 0x10c4) return 'CP210x';
  if (vendorId === 0x0403) return 'FTDI';
  if (vendorId === 0x067b) return 'Prolific PL2303';
  return undefined;
}
