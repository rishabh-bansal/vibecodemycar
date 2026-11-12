import type { BleScanner } from './scanner.ts';

/**
 * The native scanner slot. There is no native build yet, so this returns undefined and the web scanner is used.
 *
 * A Capacitor build fills it with an `in-app` scanner, for example over @capacitor-community/bluetooth-le:
 *  - `scan`: `BleClient.requestLEScan({ allowDuplicates: true }, r => onSeen({ id: r.device.deviceId,
 *    name: r.device.name ?? r.localName, rssi: r.rssi, serviceUuids: r.uuids ?? [],
 *    deviceClass: deviceClassFromAppearance(appearanceFrom(r)) }))`; `BleClient.isEnabled()` false →
 *    `ScanError('bluetooth-off')`, a refused permission → `ScanError('permission-denied')`.
 *  - `transport`: a `Transport` over `BleClient.connect` / `startNotifications` / `writeWithoutResponse` on the
 *    layouts in `BLE_LAYOUTS` (packages/obd-core/src/adapters/catalog.ts), chunked to 20 bytes like
 *    `WebBluetoothTransport`.
 *  - `openSettings`: `BleClient.openBluetoothSettings()`.
 * The picker, the connect path and the tests need no change.
 */
export function nativeScanner(): BleScanner | undefined {
  return undefined;
}
