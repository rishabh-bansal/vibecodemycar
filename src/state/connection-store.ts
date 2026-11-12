import { create } from 'zustand';
import type { ScannedDevice } from '../domain/adapters/likely.ts';
import { detectCar } from '../domain/catalog/cluster.ts';
import type { CarLink } from '../domain/coding/types.ts';
import { recordDiag } from '../domain/diagnostics.ts';
import { fingerprintVin, maskVin } from '../domain/vin.ts';
import type { BleScanner } from '../infra/ble/scanner.ts';
import type { ChooserScope } from '../infra/ble/web-chooser.ts';
import type { ConnectFailure } from '../infra/link/web-bluetooth.ts';
import { type Pairing, useCarStore } from './car-store.ts';

export type ConnectProblem =
  | { code: ConnectFailure; message: string }
  /** The connected car is not the one this profile was set up for. Both are shown, nothing is sent. */
  | { code: 'wrong-car'; message: string; expected: string; got: string; pending: Pairing };

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; link: CarLink }
  | { status: 'error'; problem: ConnectProblem };

/**
 * Which adapter to connect: one the in-app picker found (`scanner` + `device`, a native build or the dev fake),
 * or — the web build — whatever the user picks in the browser's chooser (`chooser`: only adapter-looking
 * devices, the default, or every device).
 */
export type ConnectVia = { chooser?: ChooserScope } | { scanner: BleScanner; device: ScannedDevice };

interface Actions {
  connectBluetooth(via?: ConnectVia): Promise<void>;
  /**
   * Re-establishes the adapter on the device the chooser already granted — no picker, no gesture.
   * Used by a running session after a mid-operation drop; undefined when nothing can reconnect.
   */
  relink(): Promise<CarLink | undefined>;
  /** Accept the car that is actually connected as the new profile pairing. */
  acceptNewCar(pairing: Pairing): void;
  disconnect(): Promise<void>;
  clearError(): void;
}

/** One link at a time: a link being replaced is closed, not just forgotten. */
function retire(state: ConnectionState): void {
  if (state.status === 'connected') void state.link.close();
}

export const useConnection = create<ConnectionState & Actions>()((set, get) => ({
  status: 'idle',

  async connectBluetooth(via = {}) {
    retire(get());
    set({ status: 'connecting' } as ConnectionState);
    // Loaded on demand: the Bluetooth/ELM engine and the logger are only needed once someone connects an adapter.
    const [{ WebBluetoothLink, LinkConnectError }, { ConnectionLogger }, { kickCloudSync }] =
      await Promise.all([
        import('../infra/link/web-bluetooth.ts'),
        import('../infra/cloud/connection-log.ts'),
        import('../infra/cloud/outbox.ts'),
      ]);
    // Every adapter command of this connection is logged (redacted at capture) and uploaded automatically.
    const logger = new ConnectionLogger(undefined, undefined, kickCloudSync);
    const ended = (reason: string) => {
      void logger.stop(reason).then(kickCloudSync);
    };
    kickCloudSync();
    recordDiag('ble', 'connect-started');
    try {
      let link: Awaited<ReturnType<typeof WebBluetoothLink.connect>>;
      try {
        const options = {
          onWire: logger.wire,
          onBluetooth: logger.bluetooth,
          onClosed: () => ended('link closed'),
        };
        if ('scanner' in via) {
          // The same ELM327 start as the browser path (ATZ, ATI, …), over the device the picker found.
          link = await WebBluetoothLink.connectTransport(
            via.scanner.transport(via.device, logger.bluetooth),
            options,
          );
          const { saveLastAdapter } = await import('../infra/ble/last-adapter.ts');
          saveLastAdapter({ id: via.device.id, ...(via.device.name ? { name: via.device.name } : {}) });
        } else {
          link = await WebBluetoothLink.connect(globalThis.navigator, {
            ...options,
            ...(via.chooser ? { chooser: via.chooser } : {}),
          });
          // Remembered, so the next visit lists it in the app's own picker and connects without the chooser.
          const granted = WebBluetoothLink.grantedAdapter;
          if (granted) {
            const { saveLastAdapter } = await import('../infra/ble/last-adapter.ts');
            saveLastAdapter(granted);
          }
        }
      } catch (e) {
        const err =
          e instanceof LinkConnectError
            ? e
            : new LinkConnectError('adapter-failed', 'Could not connect to the adapter.');
        recordDiag('ble', 'connect-failed', {
          code: err.code,
          message: err.message,
          ...(err.technical ? { technical: err.technical } : {}),
        });
        ended('connect failed');
        set({ status: 'error', problem: { code: err.code, message: err.message } } as ConnectionState);
        return;
      }
      recordDiag('ble', 'connected');

      // Pair on first connect; a different VIN later re-pairs (advisory, never a stop).
      let ident: Awaited<ReturnType<typeof link.identify>>;
      try {
        ident = await link.identify();
      } catch (e) {
        recordDiag('identify', 'failed', { message: e instanceof Error ? e.message : String(e) });
        await link.close(); // never leave an adapter open behind an error screen
        throw e;
      }
      recordDiag(
        'identify',
        ident.kind === 'ok' ? 'ok' : ident.kind,
        ident.kind === 'no-vin' && ident.why
          ? { why: ident.why, ...(ident.adapter ? { adapter: ident.adapter } : {}) }
          : undefined,
      );
      if (ident.kind === 'ok') {
        // The connection log files this session under the car, even if the VIN reply was not on the wire.
        logger.setVin(ident.vin);
        const fingerprint = await fingerprintVin(ident.vin);
        const masked = maskVin(ident.vin);
        const pairing = useCarStore.getState().pairing;
        if (!pairing) {
          useCarStore.getState().pair({ fingerprint, masked });
          recordDiag('identify', 'paired', { vinMasked: masked });
        } else if (pairing.fingerprint !== fingerprint) {
          // A different car is advisory: it becomes the paired car and the connection stays up. Backups
          // keep their own VIN, so a restore still only ever targets the car its bytes came from.
          recordDiag('identify', 'repaired', { expected: pairing.masked, got: masked });
          useCarStore.getState().pair({ fingerprint, masked });
        }
      }
      // What screen 1 no longer asks: the model year (from the VIN), the instrument cluster (its own identity,
      // two plain reads) and the platform family (the body computer's part number, one plain read). Done before the link is handed on, so a waiting request is checked against this car.
      // Skipped when the VIN did not come back: the cluster serves the VIN, so it would not answer these either.
      if (ident.kind === 'ok') {
        const detected = await detectCar(link, ident.vin);
        useCarStore.getState().setDetected(detected);
        recordDiag('identify', 'car-details', {
          ...(detected.cluster ? { cluster: detected.cluster } : {}),
          ...(detected.clusterPart ? { clusterPart: detected.clusterPart } : {}),
          ...(detected.clusterDataset ? { clusterDataset: detected.clusterDataset } : {}),
          ...(detected.modelYear ? { modelYear: detected.modelYear } : {}),
          ...(detected.bcmPart ? { bcmPart: detected.bcmPart } : {}),
          ...(detected.platform ? { platform: detected.platform } : {}),
          // The adapter's firmware (ATI / AT@1 / STI / ATPPS), so a car's sessions say what they ran through.
          ...(link.adapter ? { adapter: link.adapter } : {}),
        });
      }
      set({ status: 'connected', link } as ConnectionState);
    } catch (e) {
      recordDiag('ble', 'connect-error', { message: e instanceof Error ? e.message : String(e) });
      set({
        status: 'error',
        problem: { code: 'adapter-failed', message: 'Something went wrong while connecting.' },
      } as ConnectionState);
    }
  },

  async relink() {
    const state = get();
    if (state.status !== 'connected' || state.link.mode !== 'live') return undefined;
    const [{ WebBluetoothLink }, { ConnectionLogger }, { kickCloudSync }] = await Promise.all([
      import('../infra/link/web-bluetooth.ts'),
      import('../infra/cloud/connection-log.ts'),
      import('../infra/cloud/outbox.ts'),
    ]);
    // The re-established adapter gets its own connection log; the dead link's log already closed.
    const logger = new ConnectionLogger(undefined, undefined, kickCloudSync);
    const link = await WebBluetoothLink.reconnect(globalThis.navigator, {
      onWire: logger.wire,
      onBluetooth: logger.bluetooth,
      onClosed: () => void logger.stop('link closed').then(kickCloudSync),
    });
    if (!link) {
      void logger.stop('relink failed').then(kickCloudSync);
      return undefined;
    }
    recordDiag('ble', 'relinked');
    set({ status: 'connected', link } as ConnectionState);
    return link;
  },

  acceptNewCar(pairing) {
    useCarStore.getState().pair(pairing);
    set({ status: 'idle' } as ConnectionState);
  },

  async disconnect() {
    recordDiag('ble', 'disconnect-requested');
    const s = get();
    if (s.status === 'connected') await s.link.close();
    set({ status: 'idle' } as ConnectionState);
  },

  clearError() {
    if (get().status === 'error') set({ status: 'idle' } as ConnectionState);
  },
}));
