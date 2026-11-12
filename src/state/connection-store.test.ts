import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CarLink } from '../domain/coding/types.ts';
import { LAST_ADAPTER_KEY } from '../domain/storage-keys.ts';
import { loadLastAdapter } from '../infra/ble/last-adapter.ts';
import type { BleScanner } from '../infra/ble/scanner.ts';
import { SimulatedCar } from '../infra/link/simulator.ts';
import { useCarStore } from './car-store.ts';
import { useConnection } from './connection-store.ts';

const connect = vi.fn<(nav?: unknown, options?: { chooser?: string }) => Promise<CarLink>>();
const connectTransport = vi.fn<(transport: unknown) => Promise<CarLink>>();
/** What the browser chooser granted last, as the link reports it. */
let granted: { id: string; name?: string } | undefined;
vi.mock('../infra/link/web-bluetooth.ts', () => ({
  WebBluetoothLink: {
    connect: (nav: unknown, options: { chooser?: string }) => connect(nav, options),
    connectTransport: (transport: unknown) => connectTransport(transport),
    get grantedAdapter() {
      return granted;
    },
  },
  LinkConnectError: class extends Error {
    code = 'adapter-failed';
  },
}));

afterEach(() => {
  useConnection.setState({ status: 'idle' });
  useCarStore.setState({ pairing: undefined });
  connect.mockReset();
  connectTransport.mockReset();
  localStorage.removeItem(LAST_ADAPTER_KEY);
  granted = undefined;
});

describe('connection store — one link at a time', () => {
  it('offers only a real adapter connection: there is no simulated car to connect', () => {
    const actions = Object.keys(useConnection.getState());
    expect(actions.filter((k) => /demo|simulat/i.test(k))).toEqual([]);
    expect(actions).toContain('connectBluetooth');
  });

  it('closes the previous link before connecting over Bluetooth', async () => {
    const old = new SimulatedCar({ mode: 'live' });
    useConnection.setState({ status: 'connected', link: old });
    connect.mockResolvedValue(new SimulatedCar({ mode: 'live', vin: 'MEXTEST0000000001' }));
    await useConnection.getState().connectBluetooth();
    expect(old.closed).toBe(true);
    expect(useConnection.getState().status).toBe('connected');
  });

  it('closes the adapter when reading the car identity throws, and reports the error', async () => {
    const link = new SimulatedCar({ mode: 'live' });
    link.identify = async () => {
      throw new Error('GATT operation failed');
    };
    connect.mockResolvedValue(link);
    await useConnection.getState().connectBluetooth();
    expect(link.closed).toBe(true);
    expect(useConnection.getState()).toMatchObject({ status: 'error', problem: { code: 'adapter-failed' } });
  });

  it('a different car than the paired one is advisory: it re-pairs and stays connected', async () => {
    useCarStore.setState({ pairing: { fingerprint: 'b'.repeat(64), masked: 'MEXK…1234' } });
    const link = new SimulatedCar({ mode: 'live', vin: 'MEXTEST0000000001' });
    connect.mockResolvedValue(link);
    await useConnection.getState().connectBluetooth();
    expect(useConnection.getState().status).toBe('connected');
    expect(link.closed).toBe(false);
    expect(useCarStore.getState().pairing?.fingerprint).not.toBe('b'.repeat(64));
  });

  it('reads the cluster and model year on connect, before the link is handed on', async () => {
    useCarStore.getState().setModel('slavia');
    const link = new SimulatedCar({ mode: 'live', vin: 'TMBJJ7NW1P3012345', parts: { '714': '6JM920310' } });
    connect.mockResolvedValue(link);
    await useConnection.getState().connectBluetooth();
    expect(useConnection.getState().status).toBe('connected');
    expect(useCarStore.getState().selection).toMatchObject({
      model: 'slavia',
      year: 2023,
      cluster: 'digital',
      detected: { cluster: 'digital', clusterPart: '6JM920310', modelYear: 2023 },
    });
    expect(link.writes).toEqual([]);
  });
});

describe('connection store — the adapter picker', () => {
  const transport = { kind: 'fake-transport' };
  const scanner: BleScanner = {
    ui: 'in-app',
    scan: () => ({ stop() {} }),
    transport: () => transport as never,
  };

  it('connects the picked device through the normal connect path and remembers it', async () => {
    connectTransport.mockResolvedValue(new SimulatedCar({ mode: 'live', vin: 'MEXTEST0000000001' }));
    await useConnection.getState().connectBluetooth({
      scanner,
      device: { id: 'dev-1', name: 'OBDBLE', serviceUuids: [] },
    });
    expect(connectTransport).toHaveBeenCalledWith(transport);
    expect(connect).not.toHaveBeenCalled();
    expect(useConnection.getState().status).toBe('connected');
    expect(loadLastAdapter()).toEqual({ id: 'dev-1', name: 'OBDBLE' });
  });

  it('a failed handshake is an error and is not remembered', async () => {
    connectTransport.mockRejectedValue(new Error('no prompt'));
    await useConnection.getState().connectBluetooth({ scanner, device: { id: 'dev-2', serviceUuids: [] } });
    expect(useConnection.getState()).toMatchObject({ status: 'error', problem: { code: 'adapter-failed' } });
    expect(loadLastAdapter()).toBeUndefined();
  });

  it('the web path opens the browser chooser, filtered by default and unfiltered on request', async () => {
    connect.mockResolvedValue(new SimulatedCar({ mode: 'live' }));
    await useConnection.getState().connectBluetooth();
    expect(connect.mock.calls[0]?.[1]?.chooser).toBeUndefined(); // the link's default: adapters only
    await useConnection.getState().connectBluetooth({ chooser: 'all' });
    expect(connect.mock.calls[1]?.[1]?.chooser).toBe('all');
  });

  it('remembers the adapter picked in the browser chooser, so the app can list it next time', async () => {
    connect.mockResolvedValue(new SimulatedCar({ mode: 'live' }));
    granted = { id: 'granted-1', name: 'OBDBLE' };
    await useConnection.getState().connectBluetooth();
    expect(loadLastAdapter()).toEqual({ id: 'granted-1', name: 'OBDBLE' });
  });
});
