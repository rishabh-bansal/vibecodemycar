import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouter, createAppRouter } from '../../app/router.tsx';
import type { ScannedDevice } from '../../domain/adapters/likely.ts';
import { findFeature } from '../../domain/catalog/features.ts';
import type { CarSelection } from '../../domain/catalog/types.ts';
import type { CarLink } from '../../domain/coding/types.ts';
import { LAST_ADAPTER_KEY } from '../../domain/storage-keys.ts';
import type { BleScanner } from '../../infra/ble/scanner.ts';
import { createDemoCar } from '../../infra/link/demo.ts';
import { useCarStore } from '../../state/car-store.ts';
import { useConnection } from '../../state/connection-store.ts';
import { useSession } from '../../state/session-store.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const BLINKS = 'comfort-lane-change-indicator-5-flashes';

/** What each connect path does in this test: the browser chooser, or a transport the picker opened. */
const web = vi.fn<(options?: { chooser?: string }) => Promise<CarLink>>();
const overTransport = vi.fn<(t: { id: string }) => Promise<CarLink>>();
vi.mock('../../infra/link/web-bluetooth.ts', () => ({
  WebBluetoothLink: {
    connect: (_nav: unknown, options?: { chooser?: string }) => web(options),
    connectTransport: (t: { id: string }) => overTransport(t),
    reconnect: async () => undefined,
  },
  LinkConnectError: class extends Error {
    code = 'adapter-failed';
  },
}));

let scanner: BleScanner;
vi.mock('../../infra/ble/select.ts', () => ({ selectScanner: async () => scanner }));

let push: ((d: ScannedDevice) => void) | undefined;
const inApp: BleScanner = {
  ui: 'in-app',
  scan(onSeen) {
    push = onSeen;
    return { stop() {} };
  },
  transport: (device) => ({ id: device.id }) as never,
};

function demoCar(): CarLink {
  const feature = findFeature(CAR, BLINKS);
  if (!feature) throw new Error('fixture');
  return Object.assign(createDemoCar(feature, 'value-5', { latencyMs: 0, pendingMs: 0 }), {
    mode: 'live' as const,
  });
}

function mount() {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/connect?feature=${BLINKS}&setting=value-5`] }),
  );
  render(<AppRouter instance={router} />);
  return router;
}
const connectButton = () => screen.findByRole('button', { name: /connect via bluetooth/i });

beforeEach(async () => {
  await waitFor(() => expect(useSession.getState().running).toBe(false), { timeout: 5000 });
  useSession.getState().reset();
  useCarStore.setState({ selection: CAR, pairing: undefined });
  useConnection.setState({ status: 'idle' });
  web.mockReset();
  overTransport.mockReset();
  push = undefined;
  localStorage.removeItem(LAST_ADAPTER_KEY);
});

describe('Connect → adapter picker', () => {
  it('in-app scanner: the sheet opens, a tapped adapter connects through the normal path, and the change starts', async () => {
    scanner = inApp;
    overTransport.mockImplementation(async () => demoCar());
    const router = mount();
    await userEvent.click(await connectButton());
    expect(await screen.findByRole('dialog', { name: 'pick your adapter.' })).toBeInTheDocument();
    act(() => push?.({ id: 'obd-1', name: 'OBDBLE', rssi: -58, serviceUuids: ['fff0'] }));
    await userEvent.click(screen.getByRole('button', { name: /OBDBLE/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/coding'));
    expect(overTransport).toHaveBeenCalledWith({ id: 'obd-1' });
    expect(web).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(LAST_ADAPTER_KEY) ?? '{}')).toEqual({
      id: 'obd-1',
      name: 'OBDBLE',
    });
  });

  it('in-app scanner: a failed handshake stays on the sheet and leaves the Connect screen clean', async () => {
    scanner = inApp;
    overTransport.mockRejectedValue(new Error('no ELM327 prompt'));
    const router = mount();
    await userEvent.click(await connectButton());
    await screen.findByRole('dialog');
    act(() =>
      push?.({ id: 'buds', name: 'boAt Airdopes', rssi: -45, serviceUuids: [], deviceClass: 'audio' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /boAt Airdopes/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("this doesn't answer like an OBD adapter");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/connect');
    expect(useConnection.getState().status).toBe('idle');
    expect(localStorage.getItem(LAST_ADAPTER_KEY)).toBeNull();
  });

  it('web (system chooser): no sheet; the tap opens the browser chooser directly', async () => {
    const { webScanner } = await import('../../infra/ble/web-scanner.ts');
    scanner = webScanner;
    web.mockImplementation(async () => demoCar());
    const router = mount();
    // The scanner is chosen after the first render; the tap must go to the browser chooser either way.
    await act(async () => {});
    await userEvent.click(await connectButton());
    await waitFor(() => expect(router.state.location.pathname).toBe('/coding'));
    expect(web).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('web: nothing picked → "no adapter found." with the unfiltered chooser as the fallback', async () => {
    const { webScanner } = await import('../../infra/ble/web-scanner.ts');
    const { LinkConnectError } = await import('../../infra/link/web-bluetooth.ts');
    scanner = webScanner;
    web.mockRejectedValueOnce(
      Object.assign(new LinkConnectError('no-adapter', 'none'), { code: 'no-adapter' }),
    );
    web.mockImplementationOnce(async () => demoCar());
    const router = mount();
    await act(async () => {});
    await userEvent.click(await connectButton());
    expect(await screen.findByRole('heading', { name: 'no adapter found.' })).toBeInTheDocument();
    expect(web.mock.calls[0]?.[0]?.chooser).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Show all Bluetooth devices' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/coding'));
    expect(web.mock.calls[1]?.[0]?.chooser).toBe('all');
  });

  it('web, Chrome without device memory: after one chooser connect on this page, Connect lists that adapter in-app', async () => {
    const { webScanner } = await import('../../infra/ble/web-scanner.ts');
    const { rememberGrant, forgetGrants } = await import('../../infra/ble/web-remembered.ts');
    scanner = webScanner;
    const requestDevice = vi.fn();
    Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice } });
    try {
      // What the link does when the chooser's adapter connects.
      rememberGrant({ id: 'granted-1', name: 'OBDBLE', addEventListener() {}, removeEventListener() {} });
      overTransport.mockImplementation(async () => demoCar());
      const router = mount();
      await act(async () => {});
      await userEvent.click(await connectButton());
      await userEvent.click(await screen.findByRole('button', { name: /OBDBLE/ }));
      await waitFor(() => expect(router.state.location.pathname).toBe('/coding'));
      expect(web).not.toHaveBeenCalled();
      expect(requestDevice).not.toHaveBeenCalled();
    } finally {
      forgetGrants();
      Reflect.deleteProperty(navigator, 'bluetooth');
    }
  });

  describe('web, with an adapter the browser remembers', () => {
    const saved = {
      id: 'granted-1',
      name: 'OBDBLE',
      addEventListener() {},
      removeEventListener() {},
    };
    const requestDevice = vi.fn();
    beforeEach(() => {
      requestDevice.mockReset();
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        value: { requestDevice, getDevices: async () => [saved] },
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'bluetooth');
    });

    it("lists it in the app's own picker; a tap connects to it without the browser's chooser", async () => {
      const { webScanner } = await import('../../infra/ble/web-scanner.ts');
      scanner = webScanner;
      overTransport.mockImplementation(async () => demoCar());
      const router = mount();
      await act(async () => {});
      await userEvent.click(await connectButton());
      const sheet = await screen.findByRole('dialog', { name: 'pick your adapter.' });
      expect(sheet).toHaveTextContent('Your adapters · 1');
      await userEvent.click(await screen.findByRole('button', { name: /OBDBLE/ }));
      await waitFor(() => expect(router.state.location.pathname).toBe('/coding'));
      expect(overTransport).toHaveBeenCalledOnce();
      expect(web).not.toHaveBeenCalled();
      expect(requestDevice).not.toHaveBeenCalled();
    });

    it('"Find a new adapter" closes the picker and opens the browser chooser', async () => {
      const { webScanner } = await import('../../infra/ble/web-scanner.ts');
      scanner = webScanner;
      web.mockImplementation(async () => demoCar());
      const router = mount();
      await act(async () => {});
      await userEvent.click(await connectButton());
      await userEvent.click(await screen.findByRole('button', { name: /find a new adapter/i }));
      await waitFor(() => expect(router.state.location.pathname).toBe('/coding'));
      expect(web).toHaveBeenCalledOnce();
      expect(overTransport).not.toHaveBeenCalled();
    });

    it('an unplugged saved adapter says to check it, not that it is not an adapter', async () => {
      const { webScanner } = await import('../../infra/ble/web-scanner.ts');
      scanner = webScanner;
      overTransport.mockRejectedValue(new Error('GATT connect failed'));
      mount();
      await act(async () => {});
      await userEvent.click(await connectButton());
      await userEvent.click(await screen.findByRole('button', { name: /OBDBLE/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent("couldn't reach it");
    });
  });

  it('web: Bluetooth blocked for the site explains why', async () => {
    const { webScanner } = await import('../../infra/ble/web-scanner.ts');
    const { LinkConnectError } = await import('../../infra/link/web-bluetooth.ts');
    scanner = webScanner;
    web.mockRejectedValueOnce(
      Object.assign(new LinkConnectError('permission-denied', 'blocked'), { code: 'permission-denied' }),
    );
    mount();
    await act(async () => {});
    await userEvent.click(await connectButton());
    expect(
      await screen.findByRole('heading', { name: 'Bluetooth is blocked for this site.' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/needs Bluetooth to reach the adapter/)).toBeInTheDocument();
  });
});
