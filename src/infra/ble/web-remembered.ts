import { type BleDevice, type BleObservation, WebBluetoothTransport } from '@obdcraft/obd-core';
import type { ScannedDevice } from '../../domain/adapters/likely.ts';
import { type BleScanner, ScanError } from './scanner.ts';

/** A device this site was already allowed to use, as `navigator.bluetooth.getDevices()` returns it. */
interface GrantedDevice extends BleDevice {
  watchAdvertisements?(options?: { signal?: AbortSignal }): Promise<void>;
  addEventListener(type: string, cb: (e: never) => void): void;
  removeEventListener(type: string, cb: (e: never) => void): void;
}
interface AdvertisementEvent {
  rssi?: number | null;
  uuids?: readonly string[];
}
interface RememberingBluetooth {
  requestDevice(opts: unknown): Promise<BleDevice>;
  getDevices?(): Promise<GrantedDevice[]>;
}

const bluetoothOf = (nav: unknown): RememberingBluetooth | undefined => {
  const bt = (nav as { bluetooth?: Partial<RememberingBluetooth> } | undefined)?.bluetooth;
  return bt && typeof bt.requestDevice === 'function' ? (bt as RememberingBluetooth) : undefined;
};

/**
 * Adapters the chooser granted while this page is open. A grant lasts for the page: the device can be opened
 * again (after Disconnect, or a drop) without the chooser, even where the browser keeps nothing across visits.
 */
const sessionGrants = new Map<string, GrantedDevice>();
export function rememberGrant(device: BleDevice): void {
  sessionGrants.set(device.id, device as GrantedDevice);
}
/** Tests: forget this page's grants. */
export function forgetGrants(): void {
  sessionGrants.clear();
}

/**
 * The adapters this site can open without the chooser: what the browser remembers across visits (where it
 * supports `getDevices`; Chrome keeps that behind a flag on most platforms) and what was granted on this page.
 */
export async function rememberedAdapters(nav: unknown = globalThis.navigator): Promise<GrantedDevice[]> {
  const bt = bluetoothOf(nav);
  if (!bt) return [];
  let kept: GrantedDevice[] = [];
  try {
    if (typeof bt.getDevices === 'function') kept = await bt.getDevices();
  } catch {
    // Unsupported or refused: only this page's grants.
  }
  const all = new Map(sessionGrants);
  for (const d of kept) all.set(d.id, d);
  return [...all.values()];
}

const asScanned = (d: GrantedDevice, ad?: AdvertisementEvent): ScannedDevice => ({
  id: d.id,
  ...(d.name ? { name: d.name } : {}),
  ...(typeof ad?.rssi === 'number' ? { rssi: ad.rssi } : {}),
  serviceUuids: ad?.uuids ?? [],
});

/**
 * The web build's in-app picker: the adapters the browser already granted this site (it remembers them across
 * visits where it supports `getDevices`). Tapping one connects straight to it — no browser chooser. Where the
 * browser can also watch advertisements, a remembered adapter that is in range shows its signal.
 * A new adapter still needs the browser's own chooser once (the picker's "Find a new adapter").
 */
export function webRememberedScanner(nav: unknown = globalThis.navigator): BleScanner & { saved: true } {
  const granted = new Map<string, GrantedDevice>();
  return {
    ui: 'in-app',
    saved: true,
    scan(onSeen, onError) {
      const bt = bluetoothOf(nav);
      if (!bt) {
        onError(new ScanError('not-supported', 'This browser cannot use Bluetooth.'));
        return { stop() {} };
      }
      const abort = new AbortController();
      const cleanups: (() => void)[] = [];
      void rememberedAdapters(nav).then((devices) => {
        if (abort.signal.aborted) return;
        for (const d of devices) {
          granted.set(d.id, d);
          onSeen(asScanned(d));
          if (typeof d.watchAdvertisements !== 'function') continue;
          const heard = (e: AdvertisementEvent) => onSeen(asScanned(d, e));
          d.addEventListener('advertisementreceived', heard as (e: never) => void);
          cleanups.push(() => d.removeEventListener('advertisementreceived', heard as (e: never) => void));
          // Out of range simply never reports; a refusal only means no signal is shown.
          d.watchAdvertisements({ signal: abort.signal }).catch(() => {});
        }
      });
      return {
        stop() {
          abort.abort();
          for (const c of cleanups.splice(0)) c();
        },
      };
    },
    transport(device: ScannedDevice, observer?: (event: BleObservation) => void) {
      const bt = bluetoothOf(nav);
      const d = granted.get(device.id);
      if (!bt || !d) throw new ScanError('not-supported', 'That adapter is no longer remembered.');
      // Opening a granted device connects to it directly; the chooser is never shown.
      return new WebBluetoothTransport(bt, undefined, observer, d);
    },
  };
}
