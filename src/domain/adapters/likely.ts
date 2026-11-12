/**
 * What the adapter picker knows about a Bluetooth device before connecting to it: whether it looks like an OBD
 * adapter, how strong its signal is, and the short lines the picker shows under its name. Pure: no Bluetooth,
 * no timers, no storage.
 */

/** A device as a scan reports it. Repeat sightings of one device carry the same `id`. */
export interface ScannedDevice {
  id: string;
  /** The advertised (or cached) name; absent for devices that advertise none. */
  name?: string;
  /** Signal strength of the latest sighting, in dBm. */
  rssi?: number;
  /** Advertised service UUIDs, short ("fff0") or full 128-bit form. */
  serviceUuids: readonly string[];
  /**
   * What the device says it is, from its advertised appearance (BLE) or class of device (Classic). A scanner
   * fills it with {@link deviceClassFromAppearance} or {@link deviceClassFromMajorClass}.
   */
  deviceClass?: DeviceClass;
}

export type DeviceClass = 'audio' | 'wearable' | 'other';

/** Names OBD adapters advertise. Only a hint: excluded classes (audio, wearables) never count. */
export const LIKELY_NAME = /obd|elm|vgate|veepeak|obdlink|vlinker|icar|konnwei|v-link/i;

/** Serial services ELM327 BLE adapters advertise (16-bit UUIDs): FFF0, FFE0, 18F0. */
export const LIKELY_SERVICES = [0xfff0, 0xffe0, 0x18f0] as const;

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
/** The 128-bit form of a 16-bit Bluetooth UUID, lowercase, as Web Bluetooth and native stacks report it. */
export const fullUuid = (short: number): string => `0000${short.toString(16).padStart(4, '0')}${BASE_SUFFIX}`;

/** The 16-bit value of a UUID in either form; undefined for a vendor 128-bit UUID. */
export function shortUuid(uuid: string): number | undefined {
  const u = uuid.trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(u)) return Number.parseInt(u, 16);
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
  return m ? Number.parseInt(m[1] as string, 16) : undefined;
}

/** The advertised serial service, if it is one adapters use. */
export function adapterService(device: Pick<ScannedDevice, 'serviceUuids'>): number | undefined {
  for (const uuid of device.serviceUuids) {
    const s = shortUuid(uuid);
    if (s !== undefined && (LIKELY_SERVICES as readonly number[]).includes(s)) return s;
  }
  return undefined;
}

/**
 * Audio and wearable devices by their advertised GAP appearance (Bluetooth Assigned Numbers §2.6: the category
 * is the top 10 bits). Audio: media player 0x00A, audio sink 0x021, audio source 0x022, wearable audio 0x025,
 * hearing aid 0x029. Wearable: watch 0x003, eye-glasses 0x007, heart rate 0x00D, running/walking 0x011,
 * pulse oximeter 0x031.
 */
export function deviceClassFromAppearance(appearance: number | undefined): DeviceClass | undefined {
  if (appearance === undefined || appearance <= 0) return undefined;
  const category = appearance >> 6;
  if ([0x00a, 0x021, 0x022, 0x025, 0x029].includes(category)) return 'audio';
  if ([0x003, 0x007, 0x00d, 0x011, 0x031].includes(category)) return 'wearable';
  return 'other';
}

/** Classic Bluetooth class of device: major class 0x04 is audio/video, 0x07 wearable. */
export function deviceClassFromMajorClass(major: number | undefined): DeviceClass | undefined {
  if (major === undefined) return undefined;
  if (major === 0x04) return 'audio';
  if (major === 0x07) return 'wearable';
  return 'other';
}

/**
 * Names that are almost always headphones, speakers or wearables. Many such devices advertise no appearance,
 * so these names exclude a device the same way an audio or wearable class does, and give the greyed row its hint.
 */
const AUDIO_NAME =
  /airpods|\bbuds\b|earbud|headphone|headset|speaker|soundbar|\bjbl\b|bose|rockerz|\bboat\b|sony wh|sony wf/i;
const WEARABLE_NAME = /watch|\bband\b|fitbit|amazfit|noise ?fit/i;

/**
 * True when a device looks like an OBD adapter: its name matches a known adapter name, or it advertises one of
 * the adapter serial services — unless it says it is an audio or wearable device, which no adapter is.
 */
/** Audio or wearable, by advertised class or by a name that says so. */
export function isAudioOrWearable(device: Pick<ScannedDevice, 'name' | 'deviceClass'>): boolean {
  if (device.deviceClass === 'audio' || device.deviceClass === 'wearable') return true;
  const name = device.name ?? '';
  return AUDIO_NAME.test(name) || WEARABLE_NAME.test(name);
}

export function isLikelyObdAdapter(device: ScannedDevice): boolean {
  if (isAudioOrWearable(device)) return false;
  if (device.name && LIKELY_NAME.test(device.name)) return true;
  return adapterService(device) !== undefined;
}

export type SignalBars = 1 | 2 | 3;

/** 3 bars at -60 dBm or stronger, 2 at -75 or stronger, else 1. An unknown signal shows 1. */
export function signalBars(rssi: number | undefined): SignalBars {
  if (rssi === undefined) return 1;
  if (rssi >= -60) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

/** Below -80 dBm the picker asks the user to move closer. */
export const MOVE_CLOSER_DBM = -80;

const SIGNAL_WORDS: Record<SignalBars, string> = { 3: 'strong signal', 2: 'good signal', 1: 'weak signal' };

export function signalText(rssi: number | undefined): string {
  if (rssi === undefined) return 'signal unknown';
  const words = SIGNAL_WORDS[signalBars(rssi)];
  return rssi < MOVE_CLOSER_DBM ? `${words} · move closer` : words;
}

/** The chip or protocol the name or service suggests: "vLinker · STN", "ELM327", "FFF0 serial". */
export function chipText(device: ScannedDevice): string | undefined {
  if (isAudioOrWearable(device)) return undefined;
  const name = device.name ?? '';
  if (/vlinker|v-link|vlink|obdlink/i.test(name)) return 'STN chip';
  if (/elm|obd|vgate|icar|veepeak|konnwei/i.test(name)) return 'ELM327';
  const service = adapterService(device);
  return service !== undefined ? `${service.toString(16).toUpperCase()} serial` : undefined;
}

/** The line under a device's name: chip/protocol · BLE · signal. */
export function subline(device: ScannedDevice): string {
  return [chipText(device), 'BLE', signalText(device.rssi)].filter(Boolean).join(' · ');
}

/** Why a device sits under OTHER DEVICES: shown greyed under its name. */
export function otherHint(device: ScannedDevice): string {
  return isAudioOrWearable(device) ? 'not an adapter' : 'try only if nothing above works';
}

/** What the picker calls a device that advertises no name. */
export const UNNAMED = 'Unnamed device';

export const displayName = (device: ScannedDevice): string => device.name?.trim() || UNNAMED;
