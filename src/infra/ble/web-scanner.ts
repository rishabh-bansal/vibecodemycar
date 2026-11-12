import { type BleScanner, ScanError } from './scanner.ts';

/**
 * The web build's scanner. Web Bluetooth cannot list nearby devices to a page (`requestLEScan` is behind a flag
 * in Chrome and absent elsewhere), so the browser's own chooser does the listing, filtered to adapters
 * (infra/ble/web-chooser.ts). Once an adapter has been granted, the app's own picker lists it instead where the
 * browser remembers devices (infra/ble/web-remembered.ts).
 */
export const webScanner: BleScanner = {
  ui: 'system-chooser',
  scan(_onSeen, onError) {
    onError(new ScanError('not-supported', 'This browser lists devices in its own chooser.'));
    return { stop() {} };
  },
  transport() {
    throw new ScanError('not-supported', 'The browser opens the chosen device itself.');
  },
};
