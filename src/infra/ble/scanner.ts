import type { BleObservation, Transport } from '@obdcraft/obd-core';
import type { ScannedDevice } from '../../domain/adapters/likely.ts';

/**
 * The one seam between the adapter picker and the platform's Bluetooth.
 *
 *  - `system-chooser` (the web build, Web Bluetooth): a page cannot scan, so the browser shows its own device
 *    list. The app skips its picker sheet and opens the browser's chooser, filtered to adapters
 *    (infra/link/web-bluetooth.ts with infra/ble/web-chooser.ts).
 *  - `in-app` (a native build, and the fake scanner for tests and dev): `scan` reports what is nearby and the
 *    app shows its own picker sheet; `transport` opens the chosen device for the normal ELM327 connect path.
 */
export interface BleScanner {
  readonly ui: 'system-chooser' | 'in-app';
  /**
   * Starts a scan. Every advertisement is reported, repeats of one device included (the picker merges them
   * by id). Failures arrive on `onError`, never as a throw. Scanning stops when `stop` is called.
   */
  scan(onSeen: (device: ScannedDevice) => void, onError: (error: ScanError) => void): ScanHandle;
  /** The byte pipe to a scanned device. Opening it is the first step of the existing connect path. */
  transport(device: ScannedDevice, observer?: (event: BleObservation) => void): Transport;
  /** Opens the phone's Bluetooth settings, where the platform allows it (native builds). */
  openSettings?(): void;
}

export interface ScanHandle {
  stop(): void;
}

export type ScanFailure = 'bluetooth-off' | 'permission-denied' | 'not-supported';

export class ScanError extends Error {
  readonly code: ScanFailure;
  constructor(code: ScanFailure, message: string = code) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
  }
}
